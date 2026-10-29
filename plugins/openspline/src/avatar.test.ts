// SPDX-FileCopyrightText: 2026 OpenSpline contributors
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { Openspline } from '@openspline/node';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarSession } from './avatar.js';

initializeLogger({ pretty: false, level: 'fatal' });
afterEach(() => vi.restoreAllMocks());

describe('OpenSpline avatar', () => {
  it('validates the source and keeps provider credentials separate', () => {
    expect(() => new AvatarSession({})).toThrow('exactly one');
    expect(() => new AvatarSession({ portrait: 'x', avatarId: 'y' })).toThrow('exactly one');
    expect(new AvatarSession({ avatarId: 'saved', apiKey: 'cloud' }).provider).toBe('openspline');
  });

  it('preserves an allocation error and leaves the session output unchanged', async () => {
    const failure = new Error('provider allocation failed');
    const client = new Openspline();
    const create = vi.spyOn(client, 'avatar').mockRejectedValue(failure);
    const avatar = new AvatarSession({
      portrait: 'x',
      client,
      livekitUrl: 'wss://example.com',
      livekitApiKey: 'key',
      livekitApiSecret: 'secret',
    });
    const room = Object.assign(new EventEmitter(), {
      isConnected: true,
      name: 'test',
      localParticipant: { identity: 'agent' },
      remoteParticipants: new Map(),
    }) as unknown as Room;
    const session = new voice.AgentSession();
    await expect(avatar.start(session, room)).rejects.toBe(failure);
    expect(create).toHaveBeenCalledExactlyOnceWith('x', {
      quality: undefined,
      background: undefined,
    });
    expect(session.output.audio).toBeNull();
    await avatar.aclose();
  });
});
