// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarSession } from './avatar.js';

describe('Tavus AvatarSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls base AvatarSession.start first', async () => {
    const sentinel = new Error('super-start-called');
    const superStartSpy = vi
      .spyOn(voice.AvatarSession.prototype, 'start')
      .mockRejectedValue(sentinel);

    const avatar = new AvatarSession({ apiKey: 'k', faceId: 'f1' });

    await expect(
      avatar.start(
        { _started: false, output: { audio: null } } as unknown as voice.AgentSession,
        {} as unknown as Room,
      ),
    ).rejects.toThrow('super-start-called');
    expect(superStartSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts both new (faceId/palId) and deprecated (replicaId/personaId) options', () => {
    expect(() => new AvatarSession({ apiKey: 'k', faceId: 'f1', palId: 'p1' })).not.toThrow();
    expect(
      () => new AvatarSession({ apiKey: 'k', replicaId: 'r1', personaId: 'x1' }),
    ).not.toThrow();
  });
});
