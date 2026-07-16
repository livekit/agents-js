// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
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

function createRoom(performRpc: () => Promise<string>) {
  const avatar = { identity: 'avatar' };

  return {
    isConnected: true,
    localParticipant: {
      performRpc: vi.fn(performRpc),
      registerRpcMethod: vi.fn(),
    },
    remoteParticipants: new Map([[avatar.identity, avatar]]),
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe('DataStreamAudioOutput.clearBuffer', () => {
  it('handles a rejected clear-buffer RPC', async () => {
    const room = createRoom(() => Promise.reject(new Error('Failed to send')));
    const output = new DataStreamAudioOutput({
      room: room as unknown as Room,
      destinationIdentity: 'avatar',
    });

    await vi.waitFor(() => {
      output.clearBuffer();
      expect(room.localParticipant.performRpc).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());
  });
});
