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

  describe('aclose', () => {
    function mockFetch(status: number) {
      const f = vi.fn().mockResolvedValue({
        ok: status < 400,
        status,
        text: async () => `status ${status}`,
      } as Response);
      global.fetch = f as unknown as typeof fetch;
      return f;
    }

    it('ends the conversation once, even when called twice', async () => {
      // the replica keeps running until its conversation ends, not when the agent leaves
      const f = mockFetch(200);
      const avatar = new AvatarSession({ apiKey: 'k', apiUrl: 'http://tavus.test' });
      avatar.conversationId = 'c1';

      await avatar.aclose();
      await avatar.aclose();

      expect(f).toHaveBeenCalledTimes(1);
      expect(f.mock.calls[0]![0]).toBe('http://tavus.test/conversations/c1/end');
      expect(avatar.conversationId).toBeNull();
    });

    it('does not throw when ending the conversation fails', async () => {
      // ending is best effort: a failure must not break the job's shutdown
      const f = mockFetch(401);
      const avatar = new AvatarSession({ apiKey: 'k', apiUrl: 'http://tavus.test' });
      avatar.conversationId = 'c1';

      await expect(avatar.aclose()).resolves.toBeUndefined();
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('sends nothing before start', async () => {
      const f = mockFetch(200);
      const avatar = new AvatarSession({ apiKey: 'k' });

      await avatar.aclose();

      expect(f).not.toHaveBeenCalled();
    });
  });
});
