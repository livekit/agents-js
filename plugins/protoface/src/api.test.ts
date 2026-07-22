// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtofaceAPI, ProtofaceException } from './api.js';

describe('ProtofaceAPI', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('requires an API key', () => {
    vi.stubEnv('PROTOFACE_API_KEY', '');

    expect(() => new ProtofaceAPI()).toThrow(ProtofaceException);
  });

  it('uses env configuration and sends the expected start session request', async () => {
    vi.stubEnv('PROTOFACE_API_KEY', 'sk_test');
    vi.stubEnv('PROTOFACE_API_URL', 'https://api.example.test/');
    const fetchMock = vi.fn(async () => new Response('{"id":"sess_test"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ProtofaceAPI();
    const session = await client.startSession({
      avatarId: 'av_test',
      transport: { type: 'livekit' },
      maxDurationMs: 120_000,
    });

    expect(session).toEqual({ id: 'sess_test' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          accept: 'application/json',
          authorization: 'Bearer sk_test',
          'content-type': 'application/json',
          'user-agent': '@livekit/agents-plugin-protoface/0.0.0-test',
        }),
        body: JSON.stringify({
          avatar_id: 'av_test',
          transport: { type: 'livekit' },
          max_duration_seconds: 120,
        }),
      }),
    );
  });

  it('ends a session', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ProtofaceAPI({ apiKey: 'sk_test', apiUrl: 'https://api.example.test' });
    await expect(client.endSession('sess_test')).resolves.toEqual({});

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/sessions/sess_test/end',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
