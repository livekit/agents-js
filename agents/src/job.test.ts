// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import type { InferenceExecutor } from './ipc/inference_executor.js';
import { JobContext, type JobProcess, type RunningJobInfo } from './job.js';

const { deleteRoomMock, roomServiceClientMock } = vi.hoisted(() => ({
  deleteRoomMock: vi.fn(async () => {}),
  roomServiceClientMock: vi.fn(function RoomServiceClient() {
    return { deleteRoom: deleteRoomMock };
  }),
}));

vi.mock('livekit-server-sdk', () => ({
  RoomServiceClient: roomServiceClientMock,
}));

function createJobContext() {
  const room = {
    name: 'connected-room',
    on: vi.fn(),
    off: vi.fn(),
    isConnected: false,
    remoteParticipants: new Map(),
  };

  return new JobContext(
    {} as unknown as JobProcess,
    {
      acceptArguments: {
        name: 'agent',
        identity: 'agent',
        metadata: '',
      },
      job: {
        id: 'job-id',
        room: { name: 'assigned-room' },
      },
      url: 'wss://example.livekit.cloud',
      token: 'token',
      workerId: 'worker-id',
    } as unknown as RunningJobInfo,
    room as unknown as Room,
    vi.fn(),
    vi.fn(),
    {} as unknown as InferenceExecutor,
  );
}

describe('JobContext.deleteRoom', () => {
  it('deletes the connected room by default using the job URL', async () => {
    const ctx = createJobContext();

    await ctx.deleteRoom();

    expect(roomServiceClientMock).toHaveBeenCalledWith('wss://example.livekit.cloud');
    expect(deleteRoomMock).toHaveBeenCalledWith('connected-room');
  });

  it('deletes the provided room name when specified', async () => {
    const ctx = createJobContext();

    await ctx.deleteRoom('other-room');

    expect(deleteRoomMock).toHaveBeenCalledWith('other-room');
  });
});
