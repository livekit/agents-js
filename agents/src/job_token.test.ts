// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { CreateJobTokenResponse, type WorkerMessage } from '@livekit/protocol';
import { context as otelContext, trace } from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM } from './inference/llm.js';
import { STT } from './inference/stt.js';
import { TTS } from './inference/tts.js';
import { createAccessToken, resolveCredentials } from './inference/utils.js';
import {
  CreateJobTokenRequests,
  INFERENCE_CLAIMS,
  JobTokenClient,
  OBSERVABILITY_CLAIMS,
  getWorkerToken,
  setTokenClient,
} from './job_token.js';
import { log } from './log.js';
import { SimpleOTLPHttpLogExporter } from './telemetry/otel_http_exporter.js';
import { PinoCloudExporter } from './telemetry/pino_otel_transport.js';
import { setupCloudTracer, tracer } from './telemetry/traces.js';
import { uploadGate } from './telemetry/upload_gate.js';

type HeadersOption = Record<string, string> | (() => Promise<Record<string, string>>);
const traceExporterHeaders = vi.hoisted(() => [] as HeadersOption[]);
vi.mock('./telemetry/upload_gate.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./telemetry/upload_gate.js')>();
  class UploadGateTraceExporter extends mod.UploadGateTraceExporter {
    constructor(config: ConstructorParameters<typeof mod.UploadGateTraceExporter>[0]) {
      super(config);
      traceExporterHeaders.push(config?.headers as HeadersOption);
    }
  }
  return { ...mod, UploadGateTraceExporter };
});

const originalEnv = { ...process.env };

/** Token mode, as the worker leaves the environment for its job processes. */
function tokenModeEnv() {
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_INFERENCE_API_KEY;
  delete process.env.LIVEKIT_INFERENCE_API_SECRET;
  process.env.LIVEKIT_TOKEN = 'worker-token';
}

afterEach(() => {
  // no job token, as outside a job
  setTokenClient(new JobTokenClient(vi.fn()));
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('getWorkerToken', () => {
  it('returns LIVEKIT_TOKEN when there is no API key or secret', () => {
    tokenModeEnv();
    expect(getWorkerToken()).toBe('worker-token');
  });

  it.each([
    ['LIVEKIT_API_KEY', 'devkey'],
    ['LIVEKIT_API_SECRET', 'secret'],
  ])('is undefined when %s is set (key mode)', (name, value) => {
    tokenModeEnv();
    process.env[name] = value;
    expect(getWorkerToken()).toBeUndefined();
  });

  it('is undefined without LIVEKIT_TOKEN', () => {
    tokenModeEnv();
    delete process.env.LIVEKIT_TOKEN;
    expect(getWorkerToken()).toBeUndefined();
  });
});

describe('CreateJobTokenRequests', () => {
  const setup = (timeout?: number) => {
    const sent: WorkerMessage[] = [];
    const requests = new CreateJobTokenRequests((msg) => sent.push(msg) > 0, timeout);
    const request = () => {
      const msg = sent.at(-1)!;
      if (msg.message.case !== 'createJobToken') throw new Error('not a job token request');
      return msg.message.value;
    };
    return { sent, requests, request };
  };

  it('sends the request and resolves with the server token', async () => {
    const { requests, request } = setup();
    const token = requests.request('AJ_1', '{"identity":"a"}');

    expect(request().jobId).toBe('AJ_1');
    expect(request().claims).toBe('{"identity":"a"}');
    expect(request().requestId).not.toBe('');

    const answered = requests.handleResponse(
      new CreateJobTokenResponse({ requestId: request().requestId, token: 'jt', expiresAt: 100n }),
    );
    expect(answered).toBe(true);
    await expect(token).resolves.toEqual({ token: 'jt', expiresAt: 100_000 });
  });

  it('rejects with the server error', async () => {
    const { requests, request } = setup();
    const token = requests.request('AJ_1', '{"video":{"agent":true}}');
    requests.handleResponse(
      new CreateJobTokenResponse({
        requestId: request().requestId,
        error: 'claim not allowed: video.agent',
      }),
    );
    await expect(token).rejects.toThrow(
      'the LiveKit server refused CreateJobToken: claim not allowed: video.agent',
    );
  });

  it('times out when the server never answers', async () => {
    const { requests, request } = setup(20);
    const token = requests.request('AJ_1', '{}');
    await expect(token).rejects.toThrow(
      'the LiveKit server did not answer the job token request in 20ms',
    );
    // a late answer is not for anyone
    expect(
      requests.handleResponse(
        new CreateJobTokenResponse({ requestId: request().requestId, token: 'late' }),
      ),
    ).toBe(false);
  });

  it('fails at once, about the connection, when the worker is not connected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const requests = new CreateJobTokenRequests(() => false);
    const token = requests.request('AJ_1', '{}');
    await expect(token).rejects.toThrow(
      'cannot ask for a job token: the worker is not connected to the LiveKit server',
    );
    expect(vi.getTimerCount(), 'no timeout left behind').toBe(0);
  });

  it('ignores responses it did not ask for', () => {
    const { requests } = setup();
    expect(requests.handleResponse(new CreateJobTokenResponse({ requestId: 'other' }))).toBe(false);
  });
});

describe('JobTokenClient', () => {
  it('caches a token per claims and renews it at half its lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    let n = 0;
    const createJobToken = vi.fn(async (claims: string) => ({
      token: `${claims}-${++n}`,
      expiresAt: Date.now() + 600_000,
    }));
    const client = new JobTokenClient(createJobToken);

    expect(await client.token('a')).toBe('a-1');
    expect(await client.token('b')).toBe('b-2');
    vi.setSystemTime(1_000_000 + 299_999);
    expect(await client.token('a')).toBe('a-1');
    expect(createJobToken).toHaveBeenCalledTimes(2);

    vi.setSystemTime(1_000_000 + 300_000);
    expect(await client.token('a')).toBe('a-3');
    expect(createJobToken).toHaveBeenCalledTimes(3);
  });

  it('asks once for concurrent requests with the same claims', async () => {
    const createJobToken = vi.fn(async () => ({ token: 't', expiresAt: Date.now() + 600_000 }));
    const client = new JobTokenClient(createJobToken);

    expect(await Promise.all([client.token('a'), client.token('a')])).toEqual(['t', 't']);
    expect(createJobToken).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error and does not cache it', async () => {
    const createJobToken = vi
      .fn()
      .mockRejectedValueOnce(new Error('the LiveKit server refused CreateJobToken: nope'))
      .mockResolvedValueOnce({ token: 't', expiresAt: Date.now() + 600_000 });
    const client = new JobTokenClient(createJobToken);

    await expect(client.token('a')).rejects.toThrow('refused CreateJobToken: nope');
    await expect(client.token('a')).resolves.toBe('t');
  });

  it('reads a cached token as absent once it has expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const client = new JobTokenClient(async () => ({ token: 't', expiresAt: 1_600_000 }));
    await client.token('a');
    vi.setSystemTime(1_599_999);
    expect(client.cachedToken('a')).toBe('t');
    vi.setSystemTime(1_600_000);
    expect(client.cachedToken('a')).toBeUndefined();
  });

  it('keepCurrent gets the tokens first, then renews each at half its lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    let n = 0;
    // the lifetime comes from the server: 'a' lives 10 minutes, 'b' 30
    const createJobToken = vi.fn(async (claims: string) => ({
      token: `${claims}-${++n}`,
      expiresAt: Date.now() + (claims === 'a' ? 600_000 : 1_800_000),
    }));
    const client = new JobTokenClient(createJobToken);

    const stop = await client.keepCurrent(['a', 'b']);
    expect(client.cachedToken('a')).toBe('a-1');
    expect(client.cachedToken('b')).toBe('b-2');

    await vi.advanceTimersByTimeAsync(299_999);
    expect(createJobToken).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.cachedToken('a')).toBe('a-3');
    expect(client.cachedToken('b')).toBe('b-2');

    // 'a' again at 600s, then both at 900s
    await vi.advanceTimersByTimeAsync(600_000);
    expect(createJobToken.mock.calls.map(([claims]) => claims)).toEqual([
      'a',
      'b',
      'a',
      'a',
      'a',
      'b',
    ]);
    expect(client.cachedToken('b')).toBe('b-6');

    stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(createJobToken).toHaveBeenCalledTimes(6);
  });

  it('keepCurrent logs a failure and asks again after a short delay', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(log(), 'warn');
    const createJobToken = vi
      .fn()
      .mockRejectedValueOnce(new Error('the worker did not answer'))
      .mockResolvedValue({ token: 't', expiresAt: Date.now() + 600_000 });
    const client = new JobTokenClient(createJobToken);

    const stop = await client.keepCurrent(['a']);
    expect(client.cachedToken('a')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'failed to get a job token, retrying');

    await vi.advanceTimersByTimeAsync(5000);
    expect(client.cachedToken('a')).toBe('t');
    stop();
  });

  it('asks for the grants of a server SDK call as claims JSON', async () => {
    const createJobToken = vi.fn(async () => ({ token: 't', expiresAt: Date.now() + 600_000 }));
    const client = new JobTokenClient(createJobToken);

    await expect(
      client.tokenProvider({ video: { roomAdmin: true, room: 'r' }, sip: { call: true } }),
    ).resolves.toBe('t');
    expect(JSON.parse(createJobToken.mock.calls[0]![0])).toEqual({
      video: { roomAdmin: true, room: 'r' },
      sip: { call: true },
    });
  });
});

/** A client that holds a token for these claims, as a job has after it started. */
async function clientWithToken(claims: string, token: string) {
  const client = new JobTokenClient(async () => ({ token, expiresAt: Date.now() + 600_000 }));
  await client.token(claims);
  return client;
}

describe('inference in token mode', () => {
  it('needs a running job: never the worker token', async () => {
    tokenModeEnv();
    const { apiKey, apiSecret } = resolveCredentials();
    const error =
      'LiveKit Inference in token mode (LIVEKIT_TOKEN without an API key and secret) needs a running job';
    // outside a job (prewarm), or in a job that has no token yet
    await expect(createAccessToken(apiKey, apiSecret)).rejects.toThrow(error);
  });

  it("uses the job's inference token in place of a signed token", async () => {
    tokenModeEnv();
    const { apiKey, apiSecret } = resolveCredentials();
    expect({ apiKey, apiSecret }).toEqual({ apiKey: '', apiSecret: '' });
    setTokenClient(await clientWithToken(INFERENCE_CLAIMS, 'inference-token'));
    await expect(createAccessToken(apiKey, apiSecret)).resolves.toBe('inference-token');
  });

  it('constructs the models before a job: only a request needs its token', () => {
    tokenModeEnv();
    // as in prewarm, kept for the job
    expect(() => new LLM({ model: 'openai/gpt-4o-mini' })).not.toThrow();
    expect(() => new STT({ model: 'deepgram/nova-3' })).not.toThrow();
    expect(() => new TTS({ model: 'cartesia/sonic' })).not.toThrow();
  });

  it('leaves prewarm for the job: it runs once, and has no token before the job', async () => {
    tokenModeEnv();
    const llm = new LLM({ model: 'openai/gpt-4o-mini' });
    const list = vi.fn(async () => {});
    (llm as unknown as { client: { models: { list: typeof list } } }).client.models.list = list;

    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(list).not.toHaveBeenCalled();

    setTokenClient(await clientWithToken(INFERENCE_CLAIMS, 'inference-token'));
    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(list).toHaveBeenCalledTimes(1);
    await llm.aclose();
  });

  it('prefers inference credentials when they are set', async () => {
    tokenModeEnv();
    process.env.LIVEKIT_INFERENCE_API_KEY = 'inference-key';
    process.env.LIVEKIT_INFERENCE_API_SECRET = 'inference-secret-inference-secret';
    const { apiKey, apiSecret } = resolveCredentials();
    expect(apiKey).toBe('inference-key');
    const token = await createAccessToken(apiKey, apiSecret);
    expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({
      iss: 'inference-key',
    });
  });

  it('signs with the API key and secret in key mode', async () => {
    tokenModeEnv();
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';
    const { apiKey, apiSecret } = resolveCredentials();
    expect(apiKey).toBe('devkey');
    const token = await createAccessToken(apiKey, apiSecret);
    expect(token).not.toBe('worker-token');
    expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({
      iss: 'devkey',
      inference: { perform: true },
    });
  });

  it('still requires a key and secret without a worker token', () => {
    tokenModeEnv();
    delete process.env.LIVEKIT_TOKEN;
    expect(() => resolveCredentials()).toThrow('apiKey is required');
  });
});

describe('telemetry in token mode', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    tokenModeEnv();
    uploadGate.reset();
    traceExporterHeaders.length = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  });

  const withJobToken = async () =>
    setTokenClient(await clientWithToken(OBSERVABILITY_CLAIMS, 'observability-token'));

  const authorization = () =>
    new Headers(fetchSpy.mock.calls.at(-1)?.[1]?.headers).get('Authorization');

  it("sends session logs with the job's observability token", async () => {
    await withJobToken();
    const exporter = new SimpleOTLPHttpLogExporter({
      observabilityUrl: 'https://example.livekit.cloud',
      resourceAttributes: {},
      scopeName: 'test',
    });
    await exporter.export([{ body: 'rec', timestampMs: 0, attributes: {} }]);
    expect(authorization()).toBe('Bearer observability-token');
  });

  it("sends job logs with the job's observability token", async () => {
    await withJobToken();
    const exporter = new PinoCloudExporter({
      observabilityUrl: 'https://example.livekit.cloud',
      roomId: 'room1',
      jobId: 'job1',
    });
    exporter.emit({ level: 30, time: 0, msg: 'hello' });
    await exporter.flush();
    expect(authorization()).toBe('Bearer observability-token');
  });

  it("sends traces with the job's current observability token", async () => {
    await withJobToken();
    try {
      await setupCloudTracer({
        roomId: 'room1',
        jobId: 'job1',
        observabilityUrl: 'https://example.livekit.cloud',
        enableLogs: false,
      });
      // the exporter reads the headers for each request, so that it follows a token renewal
      expect(traceExporterHeaders).toHaveLength(1);
      const headers = traceExporterHeaders[0] as () => Promise<Record<string, string>>;
      expect(await headers()).toEqual({ Authorization: 'Bearer observability-token' });
      setTokenClient(await clientWithToken(OBSERVABILITY_CLAIMS, 'renewed-token'));
      expect(await headers()).toEqual({ Authorization: 'Bearer renewed-token' });
    } finally {
      await (tracer.getProvider() as NodeTracerProvider).shutdown?.();
      otelContext.disable();
      trace.disable();
    }
  });

  it('never sends the worker token without a job token', async () => {
    setTokenClient(new JobTokenClient(vi.fn()));
    const exporter = new SimpleOTLPHttpLogExporter({
      observabilityUrl: 'https://example.livekit.cloud',
      resourceAttributes: {},
      scopeName: 'test',
    });
    await expect(
      exporter.export([{ body: 'rec', timestampMs: 0, attributes: {} }]),
    ).rejects.toThrow('no observability token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
