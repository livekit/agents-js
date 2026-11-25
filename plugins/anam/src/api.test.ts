// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, initializeLogger } from '@livekit/agents';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnamAPI } from './api.js';
import { AnamException } from './types.js';

function okResponse() {
  return new Response(JSON.stringify({ sessionId: 'session-test' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch() {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    okResponse(),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AnamAPI.startSession', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: 'silent' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('retries', () => {
    const personaConfig = { name: 'Test', avatarId: 'avatar-1' };
    const connOptions = { maxRetry: 2, retryInterval: 0 };

    it.each([400, 401, 403, 404, 422])('does not retry a %i', async (status) => {
      const fetchMock = stubFetch();
      fetchMock.mockResolvedValue(new Response('nope', { status }));
      const api = new AnamAPI('anam-key', 'https://anam.test', connOptions);

      const err = await api.startSession({ personaConfig }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(APIStatusError);
      expect((err as APIStatusError).statusCode).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([408, 429, 500, 503])('retries a %i and succeeds', async (status) => {
      const fetchMock = stubFetch();
      fetchMock.mockResolvedValueOnce(new Response('busy', { status }));
      const api = new AnamAPI('anam-key', 'https://anam.test', connOptions);

      await expect(api.startSession({ personaConfig })).resolves.toEqual({
        sessionId: 'session-test',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('makes maxRetry + 1 attempts, then throws the last status error', async () => {
      const fetchMock = stubFetch();
      fetchMock.mockImplementation(async () => new Response('down', { status: 503 }));
      const api = new AnamAPI('anam-key', 'https://anam.test', connOptions);

      const err = await api.startSession({ personaConfig }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(APIStatusError);
      expect((err as APIStatusError).statusCode).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries network failures and then throws APIConnectionError', async () => {
      const fetchMock = stubFetch();
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const api = new AnamAPI('anam-key', 'https://anam.test', connOptions);

      const err = await api.startSession({ personaConfig }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(APIConnectionError);
      expect((err as APIConnectionError).message).toContain('fetch failed');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each(['api.anam.ai', 'ws://api.anam.ai', ''])(
      'rejects the API URL %j without calling fetch',
      async (apiUrl) => {
        const fetchMock = stubFetch();
        const api = new AnamAPI('anam-key', apiUrl, connOptions);

        await expect(api.startSession({ personaConfig })).rejects.toBeInstanceOf(AnamException);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('recovers from a network failure', async () => {
      const fetchMock = stubFetch();
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      const api = new AnamAPI('anam-key', 'https://anam.test', connOptions);

      await expect(api.startSession({ personaConfig })).resolves.toEqual({
        sessionId: 'session-test',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
