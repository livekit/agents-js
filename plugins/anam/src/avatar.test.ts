// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarSession } from './avatar.js';

describe('Anam AvatarSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
