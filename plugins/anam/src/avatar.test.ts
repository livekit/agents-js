// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnamAPI } from './api.js';
import { AvatarSession } from './avatar.js';
import type { SessionOptions } from './types.js';

const PERSONA = { name: 'avatar', avatarId: 'avatar-id' };

async function sessionOptionsSent(
  sessionOptions?: SessionOptions,
): Promise<Record<string, unknown> | undefined> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ sessionId: 'session-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const anamApi = new AnamAPI('anam-key', 'https://api.anam.ai');
  await anamApi.startSession({
    personaConfig: PERSONA,
    livekitUrl: 'wss://example.livekit.cloud',
    livekitToken: 'token',
    sessionOptions,
  });

  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://api.anam.ai/v1/engine/session');
  const payload = JSON.parse(init!.body as string) as {
    sessionOptions?: Record<string, unknown>;
  };
  return payload.sessionOptions;
}

describe('Anam AvatarSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls base AvatarSession.start first', async () => {
    const sentinel = new Error('super-start-called');
    const superStartSpy = vi
      .spyOn(voice.AvatarSession.prototype, 'start')
      .mockRejectedValue(sentinel);

    const avatar = new AvatarSession({
      personaConfig: {
        personaId: 'persona-test',
      },
    });

    await expect(
      avatar.start({ _started: false, output: { audio: null } } as any, {} as any),
    ).rejects.toThrow('super-start-called');
    expect(superStartSpy).toHaveBeenCalledTimes(1);
  });

  it('forwards region and region policy when starting a session', async () => {
    const sent = await sessionOptionsSent({
      videoWidth: 1280,
      videoHeight: 720,
      region: 'eu',
      regionPolicy: 'strict',
    });

    expect(sent).toEqual({
      videoWidth: 1280,
      videoHeight: 720,
      region: 'eu',
      regionPolicy: 'strict',
    });
  });

  it('omits unset session options when starting a session', async () => {
    expect(await sessionOptionsSent()).toBeUndefined();
    expect(await sessionOptionsSent({})).toBeUndefined();
  });
});
