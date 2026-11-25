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

  describe('directorNotes', () => {
    it('forwards set director-notes fields on an ephemeral persona', async () => {
      const fetchMock = stubFetch();
      const api = new AnamAPI('anam-key', 'https://anam.test');

      await api.startSession({
        personaConfig: {
          name: 'Test',
          avatarId: 'avatar-1',
          directorNotes: { expressivity: 0.8, presetStyle: 'warm' },
        },
      });

      expect(sentBody(fetchMock).personaConfig.directorNotes).toEqual({
        expressivity: 0.8,
        presetStyle: 'warm',
      });
    });

    it('omits unset fields and the key when nothing is set', async () => {
      const fetchMock = stubFetch();
      const api = new AnamAPI('anam-key', 'https://anam.test');

      await api.startSession({
        personaConfig: {
          name: 'Test',
          avatarId: 'avatar-1',
          directorNotes: { expressivity: undefined, customStylePrompt: undefined },
        },
      });

      expect(sentBody(fetchMock).personaConfig).not.toHaveProperty('directorNotes');
    });

    it('keeps an expressivity of 0', async () => {
      const fetchMock = stubFetch();
      const api = new AnamAPI('anam-key', 'https://anam.test');

      await api.startSession({
        personaConfig: { name: 'Test', avatarId: 'avatar-1', directorNotes: { expressivity: 0 } },
      });

      expect(sentBody(fetchMock).personaConfig.directorNotes).toEqual({ expressivity: 0 });
    });

    it('rejects director notes on a stateful persona before calling Anam', () => {
      const fetchMock = stubFetch();
      const api = new AnamAPI('anam-key', 'https://anam.test');

      expect(() =>
        api.startSession({
          personaConfig: { personaId: 'persona-1', directorNotes: { presetStyle: 'warm' } },
        }),
      ).toThrow(AnamException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
