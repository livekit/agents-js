// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Any, Duration, ScalarType, proto3 } from '@bufbuild/protobuf';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadRecording } from './recording_upload.js';

type SubmitCallback = (error: Error | null, response?: MockResponse) => void;
type Action = (request: MockRequest, callback: SubmitCallback) => void;

class MockRequest extends EventEmitter {
  reusedSocket = false;

  constructor(private readonly callback: SubmitCallback) {
    super();
  }

  destroy(error?: Error): this {
    if (error) queueMicrotask(() => this.callback(error));
    return this;
  }
}

class MockResponse extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly statusMessage: string,
  ) {
    super();
  }

  destroy(error?: Error): this {
    if (error) queueMicrotask(() => this.emit('error', error));
    return this;
  }
}

const RetryInfo = proto3.makeMessageType('google.rpc.RetryInfo', [
  { no: 1, name: 'retry_delay', kind: 'message', T: Duration },
]);

const RpcStatus = proto3.makeMessageType('google.rpc.Status', [
  { no: 1, name: 'code', kind: 'scalar', T: ScalarType.INT32 },
  { no: 2, name: 'message', kind: 'scalar', T: ScalarType.STRING },
  { no: 3, name: 'details', kind: 'message', T: Any, repeated: true },
]);

function statusBody(...details: Any[]): Buffer {
  return Buffer.from(new RpcStatus({ code: 14, message: 'unavailable', details }).toBinary());
}

function networkError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Emit a fresh socket that finishes its TLS handshake. */
function connect(request: MockRequest): void {
  const socket = new EventEmitter();
  request.emit('socket', socket);
  socket.emit('secureConnect');
}

function respond(callback: SubmitCallback, statusCode = 200, body: Buffer = Buffer.alloc(0)): void {
  const response = new MockResponse(statusCode, statusCode < 400 ? 'OK' : 'Service Unavailable');
  callback(null, response);
  queueMicrotask(() => {
    if (body.length > 0) response.emit('data', body);
    response.emit('end');
  });
}

const succeed: Action = (request, cb) => {
  connect(request);
  respond(cb);
};

const submit = vi.fn();

/** Queue one action per attempt. The last action repeats. */
function attempts(...actions: Action[]): void {
  submit.mockReset();
  for (const [i, action] of actions.entries()) {
    const impl = (_options: unknown, callback: SubmitCallback) => {
      const request = new MockRequest(callback);
      queueMicrotask(() => action(request, callback));
      return request;
    };
    if (i === actions.length - 1) submit.mockImplementation(impl);
    else submit.mockImplementationOnce(impl);
  }
}

function upload(): Promise<void> {
  return uploadRecording(() => ({ submit }), { host: 'cloud.example.com', jwt: 'jwt' });
}

describe('uploadRecording', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'])(
    'retries %s before the TLS handshake completes',
    async (code) => {
      attempts((_request, cb) => cb(networkError(code)), succeed);

      const uploading = upload();
      await vi.runAllTimersAsync();
      await uploading;

      expect(submit).toHaveBeenCalledTimes(2);
    },
  );

  it('retries when the connection does not complete within 30s', async () => {
    attempts((request) => request.emit('socket', new EventEmitter()), succeed);

    const uploading = upload();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(submit).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await uploading;
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('does not apply the connection timeout after the TLS handshake', async () => {
    attempts((request, cb) => {
      connect(request);
      setTimeout(() => respond(cb), 60_000);
    });

    const uploading = upload();
    await vi.advanceTimersByTimeAsync(60_000);
    await uploading;

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('waits for the RetryInfo delay before retrying', async () => {
    const retryInfo = new RetryInfo({
      retryDelay: new Duration({ seconds: 1n, nanos: 500_000_000 }),
    });
    attempts((request, cb) => {
      connect(request);
      respond(cb, 503, statusBody(Any.pack(retryInfo)));
    }, succeed);

    const uploading = upload();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(submit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await uploading;
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an empty RetryInfo', Any.pack(new RetryInfo())],
    [
      'a RetryInfo with a custom type URL host',
      new Any({ typeUrl: 'example.com/google.rpc.RetryInfo' }),
    ],
  ])('retries %s immediately', async (_name, detail) => {
    attempts((request, cb) => {
      connect(request);
      respond(cb, 503, statusBody(detail));
    }, succeed);

    const uploading = upload();
    await vi.advanceTimersByTimeAsync(0);
    await uploading;

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('does not retry a response without RetryInfo', async () => {
    attempts((request, cb) => {
      connect(request);
      respond(cb, 503, statusBody());
    });

    await expect(upload()).rejects.toThrow('503 Service Unavailable');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Action]>([
    ['a total timeout', (request) => connect(request)],
    [
      'a disconnect after the TLS handshake',
      (request, cb) => {
        connect(request);
        cb(networkError('ECONNRESET', 'response lost'));
      },
    ],
    [
      'a disconnect on a reused socket',
      (request, cb) => {
        request.reusedSocket = true;
        request.emit('socket', new EventEmitter());
        cb(networkError('ECONNRESET', 'response lost'));
      },
    ],
    ['a TLS certificate failure', (_request, cb) => cb(networkError('INVALID_PURPOSE'))],
  ])('does not retry %s', async (_name, action) => {
    attempts(action);

    const rejection = expect(upload()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(900_000);
    await rejection;

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('stops after 3 retries and throws the last error', async () => {
    attempts((_request, cb) => cb(networkError('ETIMEDOUT', 'connection timed out')));

    const rejection = expect(upload()).rejects.toThrow('connection timed out');
    await vi.runAllTimersAsync();
    await rejection;

    expect(submit).toHaveBeenCalledTimes(4);
  });
});
