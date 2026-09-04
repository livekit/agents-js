// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Any, Duration, type Message, proto3 } from '@bufbuild/protobuf';
import FormData from 'form-data';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { uploadRecording } from './recording_upload.js';
import { uploadGate } from './upload_gate.js';

function fakeClientRequest(): ClientRequest {
  const request = new EventEmitter() as ClientRequest;
  request.destroy = vi.fn(() => request);
  return request;
}

interface TestRetryInfo extends Message<TestRetryInfo> {
  retryDelay?: Duration;
}

const TestRetryInfo = proto3.makeMessageType<TestRetryInfo>('google.rpc.RetryInfo', () => [
  { no: 1, name: 'retry_delay', kind: 'message', T: Duration },
]);

interface TestRpcStatus extends Message<TestRpcStatus> {
  details: Any[];
}

const TestRpcStatus = proto3.makeMessageType<TestRpcStatus>('google.rpc.Status', () => [
  { no: 3, name: 'details', kind: 'message', T: Any, repeated: true },
]);

function retryInfoBody(delaySeconds = 0): Buffer {
  const retryInfo = new TestRetryInfo({
    retryDelay: new Duration({ seconds: BigInt(delaySeconds) }),
  });
  return Buffer.from(new TestRpcStatus({ details: [Any.pack(retryInfo)] }).toBinary());
}

type FormSubmitOutcome =
  | { error: Error }
  | { hangConnection: true }
  | {
      statusCode: number;
      body?: Buffer;
      hangResponse?: boolean;
      responseError?: Error;
      onResponse?: () => void;
    };

function mockFormSubmitSequence(outcomes: FormSubmitOutcome[]) {
  let attempt = 0;
  return vi.spyOn(FormData.prototype, 'submit').mockImplementation(function submit(_opts, cb) {
    const request = fakeClientRequest();
    const outcome = outcomes[Math.min(attempt, outcomes.length - 1)]!;
    attempt += 1;

    if ('hangConnection' in outcome) return request;

    queueMicrotask(() => {
      if ('error' in outcome) {
        cb?.(outcome.error, undefined as never);
        return;
      }

      const response = new PassThrough() as PassThrough & IncomingMessage;
      response.statusCode = outcome.statusCode;
      response.statusMessage = outcome.statusCode < 400 ? 'OK' : 'Service Unavailable';
      cb?.(null, response);
      outcome.onResponse?.();

      if (outcome.hangResponse) return;
      queueMicrotask(() => {
        if (outcome.responseError) {
          response.emit('error', outcome.responseError);
          return;
        }
        response.end(outcome.body ?? Buffer.alloc(0));
      });
    });

    return request;
  });
}

function upload(observabilityUrl = 'https://example.livekit.cloud'): Promise<void> {
  return uploadRecording({
    observabilityUrl,
    jwt: 'token',
    createFormData: () => {
      const formData = new FormData();
      formData.append('header', Buffer.from('header'), {
        contentType: 'application/protobuf',
        filename: 'header.binpb',
      });
      return formData;
    },
  });
}

describe('recording upload transport', () => {
  beforeEach(() => {
    initializeLogger({ pretty: false, level: 'silent' });
    uploadGate.reset();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    uploadGate.reset();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'default https port',
      url: 'https://example.livekit.cloud',
      expected: { protocol: 'https:', host: 'example.livekit.cloud' },
    },
    {
      name: 'explicit port kept out of the hostname',
      url: 'https://obs.example.com:8443',
      expected: { protocol: 'https:', host: 'obs.example.com', port: 8443 },
    },
    {
      name: 'plaintext scheme',
      url: 'http://collector.internal',
      expected: { protocol: 'http:', host: 'collector.internal' },
    },
  ])('targets the observability URL with a $name', async ({ url, expected }) => {
    const submitSpy = mockFormSubmitSequence([{ statusCode: 200 }]);

    await upload(url);

    const options = submitSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toMatchObject({ path: '/observability/recordings/v0', ...expected });
    // Node resolves `host` as a domain name, so a port must never be glued to it.
    expect(options.host).not.toContain(':');
  });

  it('preserves a base path on the observability URL', async () => {
    const submitSpy = mockFormSubmitSequence([{ statusCode: 200 }]);

    await upload('https://obs.example.com/lk');

    expect(submitSpy.mock.calls[0]![0]).toMatchObject({
      host: 'obs.example.com',
      path: '/lk/observability/recordings/v0',
    });
  });

  it('retries connection failures and rebuilds the multipart body', async () => {
    const connectionError = Object.assign(new Error('connection failed'), {
      code: 'ECONNREFUSED',
    });
    const submitSpy = mockFormSubmitSequence([{ error: connectionError }, { statusCode: 200 }]);

    await upload();

    expect(submitSpy).toHaveBeenCalledTimes(2);
    expect(submitSpy.mock.instances[0]).not.toBe(submitSpy.mock.instances[1]);
  });

  it('stops after the initial connection attempt and three retries', async () => {
    const connectionError = Object.assign(new Error('secret upstream address'), {
      code: 'ETIMEDOUT',
    });
    const submitSpy = mockFormSubmitSequence([{ error: connectionError }]);
    const error = await upload().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('ETIMEDOUT');
    expect((error as Error).message).not.toContain('secret upstream address');
    expect(error).not.toHaveProperty('cause');
    expect(submitSpy).toHaveBeenCalledTimes(4);
  });

  it.each(['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNKNOWN_NETWORK_ERROR'])(
    'does not retry non-allowlisted failure %s',
    async (code) => {
      const connectionError = Object.assign(new Error('connection failed'), { code });
      const submitSpy = mockFormSubmitSequence([{ error: connectionError }]);

      await expect(upload()).rejects.toThrow(code);

      expect(submitSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('retries an error response only when it contains RetryInfo', async () => {
    const submitSpy = mockFormSubmitSequence([
      { statusCode: 503, body: retryInfoBody() },
      { statusCode: 200 },
    ]);

    await upload();

    expect(submitSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ordinary error response', async () => {
    const submitSpy = mockFormSubmitSequence([
      { statusCode: 503, body: Buffer.from('secret customer response') },
    ]);
    const error = await upload().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('status 503');
    expect((error as Error).message).not.toContain('secret customer response');
    expect(error).not.toHaveProperty('cause');
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a response-body failure', async () => {
    const submitSpy = mockFormSubmitSequence([
      { statusCode: 200, responseError: new Error('secret response stream detail') },
    ]);
    const error = await upload().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('response body error (status 200)');
    expect((error as Error).message).not.toContain('secret response stream detail');
    expect(error).not.toHaveProperty('cause');
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('retries when connection setup exceeds 30 seconds', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, timeout, ...args) =>
        realSetTimeout(callback, timeout === 30_000 ? 0 : timeout, ...args),
      );
    const submitSpy = mockFormSubmitSequence([{ hangConnection: true }, { statusCode: 200 }]);

    await upload();

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(submitSpy).toHaveBeenCalledTimes(2);
  });

  it('fails without retry when the full request exceeds 900 seconds', async () => {
    vi.useFakeTimers();
    let markResponseStarted!: () => void;
    const responseStarted = new Promise<void>((resolve) => {
      markResponseStarted = resolve;
    });
    const submitSpy = mockFormSubmitSequence([
      { statusCode: 200, hangResponse: true, onResponse: markResponseStarted },
    ]);
    const resultPromise = upload().then(
      () => undefined,
      (error: unknown) => error,
    );

    await responseStarted;
    await vi.advanceTimersByTimeAsync(900_000);
    const error = await resultPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('request timed out after 900 seconds');
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});
