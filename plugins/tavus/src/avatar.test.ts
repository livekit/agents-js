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

  it('setEmotion sends a conversation.set_emotion app message to the avatar', async () => {
    const publishData = vi.fn().mockResolvedValue(undefined);
    const room = { localParticipant: { publishData } } as unknown as Room;
    const avatar = new AvatarSession({ apiKey: 'k', avatarParticipantIdentity: 'tavus-1' });
    // start() keeps the room it was started in
    (avatar as unknown as { room: Room }).room = room;

    await avatar.setEmotion('happiness');

    expect(publishData).toHaveBeenCalledTimes(1);
    const [payload, options] = publishData.mock.calls[0]!;
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual({
      message_type: 'conversation',
      event_type: 'conversation.set_emotion',
      properties: { emotion: 'happiness' },
    });
    expect(options).toEqual({
      reliable: true,
      topic: 'app_messages',
      destination_identities: ['tavus-1'],
    });
  });
});
