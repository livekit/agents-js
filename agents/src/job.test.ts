// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { RoomEvent } from '@livekit/rtc-node';
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

function createJobContextWithRoom(
  infoOverrides: Partial<RunningJobInfo> = {},
  jobOverrides: Record<string, unknown> = {},
) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const room = {
    name: 'connected-room',
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
      return room;
    }),
    off: vi.fn(),
    isConnected: false,
    remoteParticipants: new Map(),
  };

  const onShutdown = vi.fn();
  const ctx = new JobContext(
    {} as unknown as JobProcess,
    {
      acceptArguments: { name: 'agent', identity: 'agent', metadata: '' },
      job: { id: 'job-id', room: { name: 'assigned-room' }, attributes: {}, ...jobOverrides },
      url: 'wss://example.livekit.cloud',
      token: 'token',
      workerId: 'worker-id',
      ...infoOverrides,
    } as unknown as RunningJobInfo,
    room as unknown as Room,
    vi.fn(),
    onShutdown,
    {} as unknown as InferenceExecutor,
  );
  return { ctx, handlers, onShutdown };
}

describe('JobContext.simulationContext', () => {
  const dispatch = JSON.stringify({
    simulationRunId: 'SR_1',
    scenario: { label: 's', userdata: '{"k":1}' },
    mode: 'SIMULATION_MODE_TEXT',
  });

  it('resolves a SimulationContext from the dispatch job attribute', () => {
    const { ctx } = createJobContextWithRoom(
      {},
      { attributes: { 'lk.simulator.dispatch': dispatch } },
    );
    const sim = ctx.simulationContext();
    expect(sim).toBeDefined();
    expect(sim!.scenario.label).toBe('s');
    expect(sim!.jobContext).toBe(ctx);
    // cached: same instance on re-read
    expect(ctx.simulationContext()).toBe(sim);
  });

  it('returns undefined without the attribute', () => {
    const { ctx } = createJobContextWithRoom();
    expect(ctx.simulationContext()).toBeUndefined();
  });

  it('returns undefined (and does not throw) on malformed dispatch JSON', () => {
    const { ctx } = createJobContextWithRoom(
      {},
      { attributes: { 'lk.simulator.dispatch': '{nope' } },
    );
    expect(ctx.simulationContext()).toBeUndefined();
    expect(ctx.simulationContext()).toBeUndefined(); // stays cached
  });

  it('returns undefined when the dispatch has no simulation_run_id', () => {
    const { ctx } = createJobContextWithRoom(
      {},
      { attributes: { 'lk.simulator.dispatch': '{"scenario":{}}' } },
    );
    expect(ctx.simulationContext()).toBeUndefined();
  });
});

describe('simulator participant lifecycle', () => {
  it('shuts the job down when a participant with lk.simulator disconnects', () => {
    const { handlers, onShutdown } = createJobContextWithRoom();
    const cb = handlers.get(RoomEvent.ParticipantDisconnected);
    expect(cb).toBeDefined();
    cb!({ identity: 'sim', attributes: { 'lk.simulator': 'true' } });
    expect(onShutdown).toHaveBeenCalledWith('simulation completed');
  });

  it('ignores non-simulator participants', () => {
    const { handlers, onShutdown } = createJobContextWithRoom();
    handlers.get(RoomEvent.ParticipantDisconnected)!({ identity: 'user', attributes: {} });
    expect(onShutdown).not.toHaveBeenCalled();
  });
});

describe('JobContext telemetry metadata', () => {
  it('includes redaction when the recording option enables it', () => {
    const ctx = createJobContext();

    expect(
      ctx._otelMetadata({
        audio: false,
        traces: true,
        logs: false,
        transcript: false,
        redaction: true,
      }),
    ).toEqual({ 'lk.redaction.enabled': true });
  });

  it('includes simulation when the job has simulation dispatch metadata', () => {
    const ctx = createJobContext({
      job: {
        id: 'job-id',
        room: { name: 'assigned-room' },
        attributes: {
          'lk.simulator.dispatch': JSON.stringify({ simulationRunId: 'sim-run' }),
        },
      },
    } as unknown as Partial<RunningJobInfo>);

    expect(ctx._otelMetadata()).toEqual({ 'lk.simulation.enabled': true });
  });
});
