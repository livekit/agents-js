// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Future, Task } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import { BackgroundAudioPlayer, BuiltinAudioClip } from './background_audio.js';
import { AgentSessionEventTypes, createAgentStateChangedEvent } from './events.js';

type BackgroundAudioInternals = {
  audioMixer: { aclose(): Promise<void> };
  playTasks: Task<void>[];
};

async function startedPlayer() {
  const session = new EventEmitter();
  const room = {
    localParticipant: {
      publishTrack: vi.fn().mockResolvedValue({ sid: 'background-audio' }),
      trackPublications: new Map(),
      unpublishTrack: vi.fn(),
    },
  } as unknown as Room;
  const player = new BackgroundAudioPlayer({
    thinkingSound: { source: BuiltinAudioClip.KEYBOARD_TYPING, volume: 0.5 },
  });

  await player.start({ room, agentSession: session as unknown as AgentSession });
  return { player, session };
}

function emitThinking(session: EventEmitter) {
  session.emit(
    AgentSessionEventTypes.AgentStateChanged,
    createAgentStateChangedEvent('listening', 'thinking'),
  );
}

describe('BackgroundAudioPlayer.close', () => {
  it('does not play when the agent starts thinking during close', async () => {
    const { player, session } = await startedPlayer();
    const internals = player as unknown as BackgroundAudioInternals;
    const mixerClose = internals.audioMixer.aclose.bind(internals.audioMixer);
    vi.spyOn(internals.audioMixer, 'aclose').mockImplementation(async () => {
      emitThinking(session);
      await mixerClose();
    });
    const play = vi.spyOn(player, 'play');

    await player.close();

    expect(play).not.toHaveBeenCalled();
  });

  it('keeps thinking sounds after close is interrupted', async () => {
    const { player, session } = await startedPlayer();
    const internals = player as unknown as BackgroundAudioInternals;
    const release = new Future<void>();
    const controller = new AbortController();
    const slow = Task.from(
      ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              void release.await.then(() => reject(signal.reason));
            },
            { once: true },
          );
        }),
    );
    internals.playTasks.push(slow);

    const close = player.close({ signal: controller.signal });
    controller.abort();
    await expect(close).rejects.toMatchObject({ name: 'AbortError' });

    const play = vi.spyOn(player, 'play');
    emitThinking(session);
    expect(play).toHaveBeenCalledOnce();

    release.resolve();
    await expect(slow.result).rejects.toMatchObject({ name: 'AbortError' });
    internals.playTasks.splice(internals.playTasks.indexOf(slow), 1);
    await player.close();
  });
});
