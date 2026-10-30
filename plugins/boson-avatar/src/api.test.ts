// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarSessionStartError, BosonAvatarAPI, type StartSessionOptions } from './api.js';
import { BosonAvatarException } from './errors.js';

const startOptions: StartSessionOptions = {
  avatarId: 'asset-1',
  livekitUrl: 'wss://tenant.livekit.cloud',
  livekitRoom: 'room-1',
  livekitToken: 'signed-livekit-token',
  avatarIdentity: 'avatar-1',
  publisherIdentity: 'voice-1',
};

function activeSession(avatarIdentity = 'avatar-1') {
  return {
    id: 'avatar-session-1',
    object: 'avatar.livekit.session',
    status: 'active',
    avatar_identity: avatarIdentity,
  };
}

function response(status: number, payload?: unknown, headers?: Record<string, string>): Response {
  if (status === 204 && payload !== undefined) {
    return {
      status,
      headers: new Headers(headers),
      text: async () => JSON.stringify(payload),
    } as Response;
  }
  return new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers });
}

function mockFetch(...outcomes: Array<Response | Error>) {
  const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(async () => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error('missing fetch outcome');
    return outcome;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('BosonAvatarAPI', () => {
  beforeEach(() => {
    vi.stubEnv('BOSON_AVATAR_API_URL', 'https://avatar.test/v1');
    vi.stubEnv('BOSON_API_KEY', '');
    vi.stubEnv('BOSONAI_API_KEY', '');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('list avatars uses provider catalog', async () => {
    const fetchMock = mockFetch(
      response(200, {
        object: 'avatar.list',
        data: [
          { avatar_id: 'asset_demo', name: 'Claire' },
          { avatar_id: 'asset_1', name: 'Emma' },
        ],
      }),
    );
    const client = new BosonAvatarAPI({ apiKey: 'boson-key', apiUrl: 'https://avatar.example/v1' });
    await expect(client.listAvatars()).resolves.toEqual([
      { avatarId: 'asset_demo', name: 'Claire' },
      { avatarId: 'asset_1', name: 'Emma' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://avatar.example/v1/avatars',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer boson-key' }),
      }),
    );
  });

  it('list avatars rejects invalid provider responses', async () => {
    const invalid = [
      { object: 'wrong', data: [] },
      { object: 'avatar.list', data: {} },
      { object: 'avatar.list', data: ['asset_demo'] },
      { object: 'avatar.list', data: [{ avatar_id: '', name: 'Claire' }] },
      { object: 'avatar.list', data: [{ avatar_id: 'asset_demo' }] },
      {
        object: 'avatar.list',
        data: [
          { avatar_id: 'asset_demo', name: 'Claire' },
          { avatar_id: 'asset_demo', name: 'Duplicate' },
        ],
      },
    ];
    for (const payload of invalid) {
      mockFetch(response(200, payload));
      const client = new BosonAvatarAPI({ apiKey: 'boson-key' });
      await expect(client.listAvatars()).rejects.toBeInstanceOf(BosonAvatarException);
    }
  });

  it('start and end use hosted contract', async () => {
    const fetchMock = mockFetch(response(201, activeSession()), response(204));
    const client = new BosonAvatarAPI({
      apiKey: 'boson-key',
      apiUrl: 'https://avatar.example/v1/',
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 7000 },
    });
    const info = await client.startSession({
      ...startOptions,
      width: 640,
      height: 480,
      maxDurationMs: 900_000,
      idempotencyKey: 'idem-1',
    });
    await client.endSession(info.id);
    expect(info).toEqual({ id: 'avatar-session-1', avatarIdentity: 'avatar-1' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://avatar.example/v1/sessions',
      'https://avatar.example/v1/sessions/avatar-session-1',
    ]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual(expect.objectContaining({ 'Idempotency-Key': 'idem-1' }));
    expect(JSON.parse(init.body as string)).toEqual({
      avatar_id: 'asset-1',
      transport: {
        type: 'livekit',
        url: 'wss://tenant.livekit.cloud',
        room_name: 'room-1',
        participant_token: 'signed-livekit-token',
        participant_identity: 'avatar-1',
        publisher_identity: 'voice-1',
        audio_source: 'data_stream',
      },
      output: { width: 640, height: 480 },
      max_duration_seconds: 900,
    });
  });

  it('retry reuses one idempotency key and honors Retry-After', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(
      response(503, { error: { code: 'busy' } }, { 'Retry-After': '5' }),
      response(201, activeSession()),
    );
    const client = new BosonAvatarAPI({
      apiKey: 'boson-key',
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    const pending = client.startSession(startOptions);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    const keys = fetchMock.mock.calls.map(
      (call) => ((call[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'],
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('non-retryable auth error preserves status and request id', async () => {
    const fetchMock = mockFetch(
      response(401, { error: { code: 'invalid_api_key', request_id: 'req-1' } }),
    );
    const client = new BosonAvatarAPI({ apiKey: 'bad-key' });
    const error = await client.startSession(startOptions).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({ statusCode: 401, requestId: 'req-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('transport failure is wrapped after retries', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(
      new TypeError('offline'),
      new DOMException('timeout', 'TimeoutError'),
    );
    const client = new BosonAvatarAPI({
      apiKey: 'boson-key',
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    const pending = client.endSession('avatar-session-1');
    const rejection = expect(pending).rejects.toBeInstanceOf(APIConnectionError);
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects missing id and identity mismatch', async () => {
    const payloads = [
      { object: 'avatar.livekit.session', status: 'active', avatar_identity: 'avatar-1' },
      activeSession('wrong-avatar'),
      { ...activeSession(), status: 'pending' },
    ];
    for (const payload of payloads) {
      const fetchMock = mockFetch(response(201, payload), response(204));
      const client = new BosonAvatarAPI({ apiKey: 'boson-key' });
      await expect(client.startSession(startOptions)).rejects.toBeInstanceOf(BosonAvatarException);
      expect(fetchMock).toHaveBeenCalledTimes('id' in payload ? 2 : 1);
    }
  });

  it('compensation log does not expose provider error', async () => {
    const secret = 'private-provider-response';
    mockFetch(
      response(201, activeSession('wrong-avatar')),
      response(503, { error: { message: secret } }),
    );
    const client = new BosonAvatarAPI({
      apiKey: 'boson-key',
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    const error = await client.startSession(startOptions).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AvatarSessionStartError);
    expect((error as AvatarSessionStartError).sessionInfo).toEqual({
      id: 'avatar-session-1',
      avatarIdentity: 'wrong-avatar',
    });
    expect(String(error)).not.toContain(secret);
  });

  it('rejects non-contract success status without retry', async () => {
    const fetchMock = mockFetch(response(202, activeSession()));
    const client = new BosonAvatarAPI({ apiKey: 'boson-key' });
    const error = await client.startSession(startOptions).catch((value: unknown) => value);
    expect(error).toMatchObject({ statusCode: 202, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates JSON delete response', async () => {
    mockFetch(response(200, { ...activeSession(), status: 'active' }));
    await expect(
      new BosonAvatarAPI({ apiKey: 'boson-key' }).endSession('avatar-session-1'),
    ).rejects.toBeInstanceOf(BosonAvatarException);
    mockFetch(response(204, { ...activeSession(), status: 'terminated' }));
    await expect(
      new BosonAvatarAPI({ apiKey: 'boson-key' }).endSession('avatar-session-1'),
    ).rejects.toBeInstanceOf(BosonAvatarException);
  });

  it('configuration uses documented environment', () => {
    vi.stubEnv('BOSON_API_KEY', 'env-key');
    vi.stubEnv('BOSON_AVATAR_API_URL', 'https://env.example/');
    expect(() => new BosonAvatarAPI()).not.toThrow();
  });

  it('missing API key fails without network access', () => {
    expect(() => new BosonAvatarAPI()).toThrow(/BOSON_API_KEY/);
  });

  it('missing API URL fails without network access', () => {
    vi.stubEnv('BOSON_AVATAR_API_URL', '');
    expect(() => new BosonAvatarAPI({ apiKey: 'boson-key' })).toThrow(/BOSON_AVATAR_API_URL/);
  });

  it('invalid API URLs fail without network access', () => {
    for (const apiUrl of [
      '/',
      'avatar.example/v1',
      'ftp://avatar.example/v1',
      'https:///v1',
      'https://avatar.example/v1?region=us',
      'https://avatar.example/v1#sessions',
      'https://user:password@avatar.example/v1',
      'https://avatar.example:invalid/v1',
      'http://avatar.example/v1',
    ]) {
      expect(() => new BosonAvatarAPI({ apiKey: 'boson-key', apiUrl })).toThrow(
        BosonAvatarException,
      );
    }
  });

  it('loopback HTTP API URLs are allowed for local development', () => {
    for (const apiUrl of [
      'http://localhost:8400/v1/',
      'http://worker.localhost:8400/v1/',
      'http://LOCALHOST:8400/v1/',
      'http://Worker.LOCALHOST:8400/v1/',
      'http://127.0.0.1:8400/v1/',
      'http://[::1]:8400/v1/',
    ]) {
      expect(() => new BosonAvatarAPI({ apiKey: 'boson-key', apiUrl })).not.toThrow();
    }
  });
});
