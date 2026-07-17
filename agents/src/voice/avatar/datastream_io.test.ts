// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Room } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { DataStreamAudioOutput } from './datastream_io.js';

const { logger } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../log.js', () => ({
  log: () => logger,
}));

function createRoom(performRpc: () => Promise<string>): Room {
  const avatar = { identity: 'avatar' };
  const room = new Room();

  Object.defineProperties(room, {
    isConnected: { value: true },
    localParticipant: {
      value: {
        performRpc: vi.fn(performRpc),
        registerRpcMethod: vi.fn(),
      },
    },
    remoteParticipants: { value: new Map([[avatar.identity, avatar]]) },
  });

  return room;
}

describe('DataStreamAudioOutput.clearBuffer', () => {
  it('handles a rejected clear-buffer RPC', async () => {
    const room = createRoom(() => Promise.reject(new Error('Failed to send')));
    const output = new DataStreamAudioOutput({
      room,
      destinationIdentity: 'avatar',
    });

    await vi.waitFor(() => {
      output.clearBuffer();
      expect(room.localParticipant.performRpc).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());
  });
});
