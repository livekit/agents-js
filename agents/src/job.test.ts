// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  vi.clearAllMocks();
});

function createJobContext(infoOverrides: Partial<RunningJobInfo> = {}) {
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
      ...infoOverrides,
    } as unknown as RunningJobInfo,
    room as unknown as Room,
    vi.fn(),
    vi.fn(),
    {} as unknown as InferenceExecutor,
  );
}

describe('JobContext.deleteRoom', () => {
  it('deletes the connected room by default using the job URL and credentials', async () => {
    const ctx = createJobContext({
      apiKey: 'api-key',
      apiSecret: 'api-secret',
    });

    await ctx.deleteRoom();

    expect(roomServiceClientMock).toHaveBeenCalledWith(
      'wss://example.livekit.cloud',
      'api-key',
      'api-secret',
    );
    expect(deleteRoomMock).toHaveBeenCalledWith('connected-room');
  });

  it('falls back to environment credentials when job credentials are absent', async () => {
    const ctx = createJobContext();

    await ctx.deleteRoom();

    expect(roomServiceClientMock).toHaveBeenCalledWith(
      'wss://example.livekit.cloud',
      undefined,
      undefined,
    );
    expect(deleteRoomMock).toHaveBeenCalledWith('connected-room');
  });

  it('deletes the provided room name when specified', async () => {
    const ctx = createJobContext();

    await ctx.deleteRoom('other-room');

    expect(deleteRoomMock).toHaveBeenCalledWith('other-room');
  });
});

describe('JobContext fake job (console mode)', () => {
  function createFakeJobContext() {
    const onConnect = vi.fn();
    const room = {
      name: 'console-room',
      on: vi.fn(),
      off: vi.fn(),
      isConnected: false,
      remoteParticipants: new Map(),
      connect: vi.fn(async () => {}),
    };

    const ctx = new JobContext(
      {} as unknown as JobProcess,
      {
        acceptArguments: { name: '', identity: 'console', metadata: '' },
        job: { id: 'console-job', room: { name: 'console-room' } },
        url: '',
        token: '',
        workerId: 'console',
        fakeJob: true,
      } as unknown as RunningJobInfo,
      room as unknown as Room,
      onConnect,
      vi.fn(),
      {} as unknown as InferenceExecutor,
    );

    return { ctx, onConnect, room };
  }

  it('reports isFakeJob', () => {
    expect(createFakeJobContext().ctx.isFakeJob).toBe(true);
    expect(createJobContext().isFakeJob).toBe(false);
  });

  it('connect() is an idempotent no-op that does not touch the room', async () => {
    const { ctx, onConnect, room } = createFakeJobContext();

    await ctx.connect();
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(room.connect).not.toHaveBeenCalled();

    await ctx.connect();
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('deleteRoom() is a no-op', async () => {
    const { ctx } = createFakeJobContext();

    await ctx.deleteRoom();

    expect(roomServiceClientMock).not.toHaveBeenCalled();
    expect(deleteRoomMock).not.toHaveBeenCalled();
  });

  it('initRecording() is a no-op and does not parse the empty URL', async () => {
    const { ctx } = createFakeJobContext();
    await expect(ctx.initRecording()).resolves.toBeUndefined();
  });
});
