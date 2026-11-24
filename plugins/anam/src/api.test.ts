// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
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

type SentBody = {
  personaConfig: Record<string, unknown>;
  sessionOptions?: Record<string, unknown>;
};

function sentBody(fetchMock: ReturnType<typeof stubFetch>): SentBody {
  const init = fetchMock.mock.calls[0]![1]!;
  return JSON.parse(init.body as string);
}

describe('AnamAPI.startSession', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: 'silent' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('sessionOptions', () => {
    const personaConfig = { name: 'Test', avatarId: 'avatar-1' };

    it('omits sessionOptions when nothing is set', async () => {
      const fetchMock = stubFetch();
      const api = new AnamAPI('anam-key', 'https://anam.test');

      await api.startSession({ personaConfig, sessionOptions: {} });

      expect(sentBody(fetchMock)).not.toHaveProperty('sessionOptions');
    });

    it.each([true, false])('forwards showAIAvatarDisclosure=%s', async (show) => {
      const fetchMock = stubFetch();
      const api = new AnamAPI('anam-key', 'https://anam.test');

      await api.startSession({ personaConfig, sessionOptions: { showAIAvatarDisclosure: show } });

      expect(sentBody(fetchMock).sessionOptions).toEqual({ showAIAvatarDisclosure: show });
    });

    it('merges the disclosure flag with video dimensions', async () => {
      const fetchMock = stubFetch();
      const api = new AnamAPI('anam-key', 'https://anam.test');

      await api.startSession({
        personaConfig,
        sessionOptions: { videoWidth: 1280, videoHeight: 720, showAIAvatarDisclosure: true },
      });

      expect(sentBody(fetchMock).sessionOptions).toEqual({
        videoWidth: 1280,
        videoHeight: 720,
        showAIAvatarDisclosure: true,
      });
    });

    it('rejects a lone video dimension', () => {
      const api = new AnamAPI('anam-key', 'https://anam.test');
      stubFetch();

      expect(() =>
        api.startSession({ personaConfig, sessionOptions: { videoWidth: 1280 } }),
      ).toThrow(AnamException);
    });
  });
});
