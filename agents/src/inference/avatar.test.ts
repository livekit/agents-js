// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { APIStatusError, APITimeoutError } from '../_exceptions.js';
import { runWithJobContextAsync } from '../job.js';
import { initializeLogger } from '../log.js';
import { type APIConnectOptions } from '../types.js';
import type * as AvatarIndex from '../voice/avatar/index.js';
import { AvatarSession, parseAvatarModel } from './avatar.js';
import { INFERENCE_PROVIDER_HEADER } from './utils.js';

const { fakeSinks } = vi.hoisted(() => ({
  fakeSinks: [] as Array<{ sampleRate?: number; destinationIdentity: string }>,
}));

vi.mock('../voice/avatar/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AvatarIndex>();
  return {
    ...actual,
    DataStreamAudioOutput: class FakeDataStreamAudioOutput {
      readonly sampleRate?: number;
      readonly destinationIdentity: string;

      constructor(opts: { sampleRate?: number; destinationIdentity: string }) {
        this.sampleRate = opts.sampleRate;
        this.destinationIdentity = opts.destinationIdentity;
        fakeSinks.push(this);
      }
    },
  };
});

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

function makeAvatar(overrides: Partial<ConstructorParameters<typeof AvatarSession>[0]> = {}) {
  return new AvatarSession({
    model: 'lemonslice',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud/v1',
    ...overrides,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function parseJwt(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('missing jwt payload');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function callCreate(av: AvatarSession) {
  return await av._createSession({
    roomName: 'my-room',
    roomSid: 'RM_123',
    livekitUrl: 'wss://example.livekit.cloud',
    workerToken: 'worker-token',
    agentIdentity: 'agent-worker-1',
  });
}

class FakeOutput {
  audio: unknown = null;
}

class FakeAgentSession {
  output = new FakeOutput();
  _started = false;
  on() {}
  off() {}
  emit() {}
}

class FakeRoom {
  name = 'my-room';
  isConnected = false;
  localParticipant?: { identity: string };
  sid?: string;
  on() {}
  off() {}
}

class FakeConnectedRoom extends FakeRoom {
  override isConnected = true;
  override localParticipant = { identity: 'standalone-agent' };
  override sid = 'RM_789';
}

class FakeJobRoom extends FakeRoom {
  // `@livekit/rtc-node` reports an empty string (not undefined) before the room connects.
  override name = '';
}

describe('parseAvatarModel', () => {
  it.each([
    ['lemonslice', 'lemonslice', undefined],
    ['lemonslice/agent_abc', 'lemonslice', 'agent_abc'],
    ['lemonslice/', 'lemonslice', undefined],
    ['bey/face_1', 'bey', 'face_1'],
  ])('parses %s', (model, provider, avatarId) => {
    expect(parseAvatarModel(model)).toEqual([provider, avatarId]);
  });

  it.each(['', '/foo', '  '])('rejects invalid provider %s', (model) => {
    expect(() => parseAvatarModel(model)).toThrow();
  });
});

describe('AvatarSession constructor', () => {
  it('sets defaults and identity', () => {
    const av = makeAvatar();
    expect(av.provider).toBe('lemonslice');
    expect(av.avatarIdentity).toBe('lemonslice-inference-avatar');
  });

  it('uses LIVEKIT_API_KEY fallback credentials', () => {
    const oldKey = process.env.LIVEKIT_API_KEY;
    const oldSecret = process.env.LIVEKIT_API_SECRET;
    const oldInferenceKey = process.env.LIVEKIT_INFERENCE_API_KEY;
    const oldInferenceSecret = process.env.LIVEKIT_INFERENCE_API_SECRET;
    try {
      delete process.env.LIVEKIT_INFERENCE_API_KEY;
      delete process.env.LIVEKIT_INFERENCE_API_SECRET;
      process.env.LIVEKIT_API_KEY = 'env-key';
      process.env.LIVEKIT_API_SECRET = 'env-secret';
      const av = new AvatarSession({ model: 'lemonslice', baseURL: 'https://x/v1' });
      expect(av['apiKey']).toBe('env-key');
      expect(av['apiSecret']).toBe('env-secret');
    } finally {
      if (oldKey === undefined) delete process.env.LIVEKIT_API_KEY;
      else process.env.LIVEKIT_API_KEY = oldKey;
      if (oldSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
      else process.env.LIVEKIT_API_SECRET = oldSecret;
      if (oldInferenceKey === undefined) delete process.env.LIVEKIT_INFERENCE_API_KEY;
      else process.env.LIVEKIT_INFERENCE_API_KEY = oldInferenceKey;
      if (oldInferenceSecret === undefined) delete process.env.LIVEKIT_INFERENCE_API_SECRET;
      else process.env.LIVEKIT_INFERENCE_API_SECRET = oldInferenceSecret;
    }
  });

  it('rejects missing credentials', () => {
    const oldKey = process.env.LIVEKIT_API_KEY;
    const oldSecret = process.env.LIVEKIT_API_SECRET;
    const oldInferenceKey = process.env.LIVEKIT_INFERENCE_API_KEY;
    const oldInferenceSecret = process.env.LIVEKIT_INFERENCE_API_SECRET;
    try {
      delete process.env.LIVEKIT_API_KEY;
      delete process.env.LIVEKIT_API_SECRET;
      delete process.env.LIVEKIT_INFERENCE_API_KEY;
      delete process.env.LIVEKIT_INFERENCE_API_SECRET;
      expect(() => new AvatarSession({ model: 'lemonslice', baseURL: 'https://x/v1' })).toThrow();
    } finally {
      if (oldKey === undefined) delete process.env.LIVEKIT_API_KEY;
      else process.env.LIVEKIT_API_KEY = oldKey;
      if (oldSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
      else process.env.LIVEKIT_API_SECRET = oldSecret;
      if (oldInferenceKey === undefined) delete process.env.LIVEKIT_INFERENCE_API_KEY;
      else process.env.LIVEKIT_INFERENCE_API_KEY = oldInferenceKey;
      if (oldInferenceSecret === undefined) delete process.env.LIVEKIT_INFERENCE_API_SECRET;
      else process.env.LIVEKIT_INFERENCE_API_SECRET = oldInferenceSecret;
    }
  });

  it('supports custom identity', () => {
    expect(makeAvatar({ avatarParticipantIdentity: 'custom-id' }).avatarIdentity).toBe('custom-id');
  });

  it('rejects image_url with model id', () => {
    expect(() =>
      makeAvatar({ model: 'lemonslice/agent_abc', extraKwargs: { image_url: 'https://x/y.png' } }),
    ).toThrow(/not both/);
  });

  it('copies extraKwargs defensively', () => {
    const extra = { prompt: 'hi' };
    const av = makeAvatar({ extraKwargs: extra });
    extra.prompt = 'changed';
    expect(av['extraKwargs']).toEqual({ prompt: 'hi' });
  });
});

it('splits known LemonSlice options and unknown extra kwargs', async () => {
  let captured: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ session_id: 'AVS_1' });
  });

  const av = makeAvatar({
    fetch: fetchMock as typeof fetch,
    extraKwargs: { idle_prompt: 'look attentive', some_future_knob: true },
  });
  await callCreate(av);

  expect(captured?.idle_prompt).toBe('look attentive');
  expect(captured?.extra_kwargs).toEqual({ some_future_knob: true });
});

it('creates a gateway session with payload, headers, and idempotency key', async () => {
  let capturedHeaders: Headers | undefined;
  let capturedBody: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ session_id: 'AVS_1', provider_session_id: 'ls_abc', sample_rate: 16000 });
  });

  const av = makeAvatar({
    fetch: fetchMock as typeof fetch,
    extraKwargs: {
      image_url: 'https://example.com/face.png',
      prompt: 'be expressive',
      idle_timeout: 300,
    },
  });
  const resp = await callCreate(av);

  expect(resp.session_id).toBe('AVS_1');
  expect(resp.provider_session_id).toBe('ls_abc');
  expect(capturedBody).toMatchObject({
    provider: 'lemonslice',
    livekit_token: 'worker-token',
    avatar_identity: 'lemonslice-inference-avatar',
    agent_identity: 'agent-worker-1',
    room_sid: 'RM_123',
    image_url: 'https://example.com/face.png',
    prompt: 'be expressive',
    idle_timeout_s: 300,
  });
  expect(capturedBody).not.toHaveProperty('extra_kwargs');
  expect(capturedHeaders?.get('Authorization')).toMatch(/^Bearer /);
  expect(capturedHeaders?.get(INFERENCE_PROVIDER_HEADER)).toBe('lemonslice');
  expect(capturedHeaders?.get('Idempotency-Key')).toBeTruthy();
});

it('sends avatar_id from model string', async () => {
  let captured: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ session_id: 'AVS_1' });
  });

  const av = makeAvatar({ model: 'lemonslice/agent_abc', fetch: fetchMock as typeof fetch });
  await callCreate(av);

  expect(captured?.avatar_id).toBe('agent_abc');
  expect(captured).not.toHaveProperty('image_url');
});

it('keeps idempotency key stable across retries', async () => {
  const keys: string[] = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    keys.push(headers.get('Idempotency-Key') ?? '');
    if (keys.length < 3) return jsonResponse({ error: 'unavailable' }, { status: 503 });
    return jsonResponse({ session_id: 'AVS_1' });
  });

  const connOptions: APIConnectOptions = { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 5 };
  const av = makeAvatar({ fetch: fetchMock as typeof fetch, connOptions });
  const resp = await callCreate(av);

  expect(resp.session_id).toBe('AVS_1');
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
});

it('does not retry non-retryable errors', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ error: 'not enabled' }, { status: 403 }));
  const av = makeAvatar({
    fetch: fetchMock as typeof fetch,
    connOptions: { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 5 },
  });

  await expect(callCreate(av)).rejects.toMatchObject({ statusCode: 403 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('retries server errors then raises', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ error: 'boom' }, { status: 502 }));
  const av = makeAvatar({
    fetch: fetchMock as typeof fetch,
    connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 5 },
  });

  await expect(callCreate(av)).rejects.toBeInstanceOf(APIStatusError);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('aborts gateway requests using the configured connOptions timeout', async () => {
  // A fetch that never resolves on its own, so the only way this settles is the
  // request timeout signal. With the old hard-coded 60s the test would hang; the
  // small connOptions.timeoutMs proves the caller-provided timeout is honored.
  const fetchMock = vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
      }),
  );
  const av = makeAvatar({
    fetch: fetchMock as typeof fetch,
    connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10 },
  });

  await expect(callCreate(av)).rejects.toBeInstanceOf(APITimeoutError);
});

it('start uses response sample rate and captures terminate token', async () => {
  fakeSinks.length = 0;
  const fetchMock = vi.fn(async () =>
    jsonResponse({
      session_id: 'AVS_1',
      provider_session_id: 'ls_1',
      terminate_token: 'tt_1',
      sample_rate: 24000,
    }),
  );
  const av = makeAvatar({ fetch: fetchMock as typeof fetch });
  const agentSession = new FakeAgentSession();
  await av.start(agentSession as never, new FakeConnectedRoom() as never, {
    livekitUrl: 'wss://example.livekit.cloud',
    livekitApiKey: 'devkey',
    livekitApiSecret: 'devsecret',
  });

  expect(av.sessionId).toBe('AVS_1');
  expect(av.providerSessionId).toBe('ls_1');
  expect(av['_terminateToken']).toBe('tt_1');
  expect(fakeSinks[0]?.sampleRate).toBe(24000);
  expect(agentSession.output.audio).toBe(fakeSinks[0]);
});

it('start mints worker token with expected grants and attributes', async () => {
  let captured: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ session_id: 'AVS_1', provider_session_id: 'ls_1' });
  });

  const av = makeAvatar({ fetch: fetchMock as typeof fetch });
  await av.start(new FakeAgentSession() as never, new FakeConnectedRoom() as never, {
    livekitUrl: 'wss://example.livekit.cloud',
    livekitApiKey: 'devkey',
    livekitApiSecret: 'devsecret',
  });

  expect(captured?.room_sid).toBe('RM_789');
  expect(captured?.agent_identity).toBe('standalone-agent');
  const claims = parseJwt(String(captured?.livekit_token));
  expect(claims.kind).toBe('agent');
  expect(claims.sub).toBe('lemonslice-inference-avatar');
  expect(claims.video).toMatchObject({ roomJoin: true, room: 'my-room' });
  expect(claims.attributes).toEqual({
    'lk.publish_on_behalf': 'standalone-agent',
    'lk.avatar_provider': 'lemonslice',
  });
});

it('start uses job room name and sid before the rtc room is connected', async () => {
  let captured: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ session_id: 'AVS_1', provider_session_id: 'ls_1' });
  });
  const jobCtx = {
    job: { room: { name: 'job-room', sid: 'RM_job' } },
    info: { acceptArguments: { identity: 'job-agent' } },
    room: new FakeJobRoom(),
    addShutdownCallback() {},
  };

  const av = makeAvatar({ fetch: fetchMock as typeof fetch });
  await runWithJobContextAsync(jobCtx as never, async () => {
    await av.start(new FakeAgentSession() as never, new FakeJobRoom() as never, {
      livekitUrl: 'wss://example.livekit.cloud',
      livekitApiKey: 'devkey',
      livekitApiSecret: 'devsecret',
    });
  });

  expect(captured?.room_name).toBe('job-room');
  expect(captured?.room_sid).toBe('RM_job');
  expect(captured?.agent_identity).toBe('job-agent');
});

it('start twice raises without creating a second provider session', async () => {
  const fetchMock = vi.fn(async () =>
    jsonResponse({ session_id: 'AVS_1', provider_session_id: 'ls_1' }),
  );
  const av = makeAvatar({ fetch: fetchMock as typeof fetch });
  const agentSession = new FakeAgentSession();
  await av.start(agentSession as never, new FakeConnectedRoom() as never, {
    livekitUrl: 'wss://example.livekit.cloud',
    livekitApiKey: 'devkey',
    livekitApiSecret: 'devsecret',
  });

  await expect(
    av.start(agentSession as never, new FakeConnectedRoom() as never, {
      livekitUrl: 'wss://example.livekit.cloud',
      livekitApiKey: 'devkey',
      livekitApiSecret: 'devsecret',
    }),
  ).rejects.toThrow(/only be called once/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(av.providerSessionId).toBe('ls_1');
});

it('sets ids before audio rebind failures', async () => {
  const fetchMock = vi.fn(async () =>
    jsonResponse({ session_id: 'AVS_1', provider_session_id: 'ls_1', terminate_token: 'tt_1' }),
  );
  const av = makeAvatar({ fetch: fetchMock as typeof fetch });
  const agentSession = new FakeAgentSession();
  Object.defineProperty(agentSession.output, 'audio', {
    set() {
      throw new Error('boom');
    },
  });

  await expect(
    av.start(agentSession as never, new FakeConnectedRoom() as never, {
      livekitUrl: 'wss://example.livekit.cloud',
      livekitApiKey: 'devkey',
      livekitApiSecret: 'devsecret',
    }),
  ).rejects.toThrow(/boom/);
  expect(av.providerSessionId).toBe('ls_1');
  expect(av['_terminateToken']).toBe('tt_1');
});

it('start rejects disconnected standalone rooms', async () => {
  const av = makeAvatar();
  await expect(
    av.start(new FakeAgentSession() as never, new FakeRoom() as never, {
      livekitUrl: 'wss://example.livekit.cloud',
      livekitApiKey: 'devkey',
      livekitApiSecret: 'devsecret',
    }),
  ).rejects.toThrow(/needs a connected room/);
});

it('aclose terminates session', async () => {
  const terminateBodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    terminateBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse({ terminated: true });
  });
  const av = makeAvatar({ fetch: fetchMock as typeof fetch });
  av['_providerSessionId'] = 'ls_abc';
  av['_terminateToken'] = 'tt_abc';

  await av.aclose();

  expect(terminateBodies).toEqual([
    { provider: 'lemonslice', provider_session_id: 'ls_abc', terminate_token: 'tt_abc' },
  ]);
  expect(av.providerSessionId).toBeNull();
  expect(av['_terminateToken']).toBeNull();
});

it('aclose skips terminate without token', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ terminated: true }));
  const av = makeAvatar({ fetch: fetchMock as typeof fetch });
  av['_providerSessionId'] = 'ls_abc';

  await av.aclose();

  expect(fetchMock).not.toHaveBeenCalled();
});

it('aclose terminate failure keeps ids and runs base cleanup', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ error: 'boom' }, { status: 500 }));
  const av = makeAvatar({ fetch: fetchMock as typeof fetch });
  av['_providerSessionId'] = 'ls_abc';
  av['_terminateToken'] = 'tt_abc';

  await av.aclose();

  expect(av.providerSessionId).toBe('ls_abc');
  expect(av['_terminateToken']).toBe('tt_abc');
});

it('aclose without session is no-op', async () => {
  await expect(makeAvatar().aclose()).resolves.toBeUndefined();
});
