// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind, Room } from '@livekit/rtc-node';
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContextAsync } from '../job.js';
import { initializeLogger } from '../log.js';
import { Agent } from '../voice/agent.js';
import { AgentSession } from '../voice/agent_session.js';
import { AudioInput, AudioOutput } from '../voice/io.js';
import { type WarmTransferResult, createWarmTransferTask } from './warm_transfer.js';

class TestAudioInput extends AudioInput {}
class TestAudioOutput extends AudioOutput {
  override clearBuffer(): void {}
}

function createDeferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

// LiveKit/SIP network calls are the only stubs here. AgentSession, AgentTask,
// caller I/O transitions, and the abort arbitration all run for real.
type TaskOutcome =
  | {
      type: 'completed';
      value: WarmTransferResult;
      callerAudioEnabled: boolean;
    }
  | { type: 'failed'; error: unknown; callerAudioEnabled: boolean };

function startTaskHarness(options?: { abortSignal?: AbortSignal }) {
  const callerRoom = {
    name: 'caller-room',
    localParticipant: { identity: 'voice-agent' },
    remoteParticipants: new Map([['caller', { identity: 'caller', kind: ParticipantKind.SIP }]]),
    on: vi.fn(),
    off: vi.fn(),
  };
  const deleteRoom = vi.fn().mockResolvedValue(undefined);
  const jobCtx = {
    room: callerRoom,
    job: { enableRecording: false },
    simulationContext: () => undefined,
    deleteRoom,
    info: {
      url: 'wss://example.invalid',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
    },
  } as unknown as JobContext;
  const session = new AgentSession({
    vad: null,
    turnHandling: { turnDetection: null },
  });
  session.input.audio = new TestAudioInput();
  session.output.audio = new TestAudioOutput();

  const task = createWarmTransferTask({
    sipCallTo: '+15551234567',
    sipTrunkId: 'ST_test',
    holdAudio: null,
    abortSignal: options?.abortSignal,
  });
  let markOnEnterStarted!: () => void;
  const onEnterStarted = new Promise<void>((resolve) => {
    markOnEnterStarted = resolve;
  });
  let settleTask!: (outcome: TaskOutcome) => void;
  const taskSettled = new Promise<TaskOutcome>((resolve) => {
    settleTask = resolve;
  });

  class CallerAgent extends Agent {
    constructor() {
      super({ instructions: 'caller agent' });
    }

    override async onEnter(): Promise<void> {
      markOnEnterStarted();
      try {
        const value = await task.run();
        settleTask({
          type: 'completed',
          value,
          callerAudioEnabled: session.output.audioEnabled,
        });
      } catch (error) {
        settleTask({
          type: 'failed',
          error,
          callerAudioEnabled: session.output.audioEnabled,
        });
      }
    }
  }

  const sessionStarted = runWithJobContextAsync(jobCtx, () =>
    session.start({ agent: new CallerAgent(), record: false }),
  );

  return {
    deleteRoom,
    onEnterStarted,
    session,
    sessionStarted,
    task,
    taskSettled,
  };
}

async function startPendingMergeHarness(abortSignal: AbortSignal) {
  const pendingRoomConnection = createDeferred();
  const roomConnect = vi
    .spyOn(Room.prototype, 'connect')
    .mockReturnValue(pendingRoomConnection.promise);
  vi.spyOn(Room.prototype, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(Room.prototype, 'name', 'get').mockReturnValue('consult-room');
  const harness = startTaskHarness({ abortSignal });

  await harness.onEnterStarted;
  await vi.waitFor(() => expect(roomConnect).toHaveBeenCalledOnce());
  expect(harness.session.output.audioEnabled).toBe(false);

  vi.spyOn(AgentSession.prototype, 'start').mockResolvedValue(undefined);
  const shutdown = vi.spyOn(AgentSession.prototype, 'shutdown').mockResolvedValue(undefined);
  const dialHumanAgent = vi
    .spyOn(SipClient.prototype, 'createSipParticipant')
    .mockResolvedValue({} as never);
  const pendingMove = createDeferred();
  const moveParticipant = vi
    .spyOn(RoomServiceClient.prototype, 'moveParticipant')
    .mockReturnValue(pendingMove.promise);

  pendingRoomConnection.resolve();
  await vi.waitFor(() => expect(dialHumanAgent).toHaveBeenCalledOnce());

  const connectTool = harness.task.toolCtx.functionTools.connect_to_caller;
  if (!connectTool) throw new Error('connect_to_caller tool not found');
  const merge = connectTool.execute({}, {} as never);
  await vi.waitFor(() =>
    expect(moveParticipant).toHaveBeenCalledWith('consult-room', 'human-agent-sip', 'caller-room'),
  );

  return { ...harness, merge, pendingMove, shutdown };
}

describe('warm transfer abortSignal lifecycle', () => {
  const previousApiKey = process.env.LIVEKIT_API_KEY;
  const previousApiSecret = process.env.LIVEKIT_API_SECRET;

  beforeEach(() => {
    initializeLogger({ pretty: false, level: 'silent' });
    process.env.LIVEKIT_API_KEY = 'test-api-key';
    process.env.LIVEKIT_API_SECRET = 'test-api-secret';
  });

  afterEach(() => {
    if (previousApiKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = previousApiKey;
    if (previousApiSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = previousApiSecret;
    vi.restoreAllMocks();
  });

  it('rejects run() with the abort reason when aborted during the dial', async () => {
    const roomConnect = vi
      .spyOn(Room.prototype, 'connect')
      .mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(Room.prototype, 'disconnect').mockResolvedValue(undefined);
    const controller = new AbortController();
    const harness = startTaskHarness({ abortSignal: controller.signal });

    try {
      await harness.onEnterStarted;
      await vi.waitFor(() => expect(roomConnect).toHaveBeenCalledOnce());
      expect(harness.session.output.audioEnabled).toBe(false);

      const reason = new Error('consult timed out');
      controller.abort(reason);

      const outcome = await harness.taskSettled;
      expect(outcome.type).toBe('failed');
      if (outcome.type !== 'failed') throw new Error('expected failure');
      // The signal's reason stays observable as the rejection itself.
      expect(outcome.error).toBe(reason);
      // Caller I/O is restored before run() settles.
      expect(outcome.callerAudioEnabled).toBe(true);
      await expect(harness.sessionStarted).resolves.toBeUndefined();
    } finally {
      await harness.session.close().catch(() => undefined);
    }
  });

  it('completes without dialing when the signal is already aborted', async () => {
    const roomConnect = vi
      .spyOn(Room.prototype, 'connect')
      .mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const reason = new Error('shutting down');
    controller.abort(reason);
    const harness = startTaskHarness({ abortSignal: controller.signal });

    try {
      const outcome = await harness.taskSettled;
      expect(outcome).toEqual({
        type: 'failed',
        error: reason,
        callerAudioEnabled: true,
      });
      expect(roomConnect).not.toHaveBeenCalled();
      await expect(harness.sessionStarted).resolves.toBeUndefined();
    } finally {
      await harness.session.close().catch(() => undefined);
    }
  });

  it('lets a committed participant move win over a concurrent abort', async () => {
    const controller = new AbortController();
    const harness = await startPendingMergeHarness(controller.signal);

    try {
      controller.abort(new Error('consult timed out'));
      const taskSettledSpy = vi.fn();
      void harness.taskSettled.then(taskSettledSpy);
      await Promise.resolve();
      // The abort is deferred while the move is in flight.
      expect(taskSettledSpy).not.toHaveBeenCalled();

      harness.pendingMove.resolve();
      await expect(harness.merge).resolves.toBeUndefined();
      await expect(harness.taskSettled).resolves.toEqual({
        type: 'completed',
        value: { humanAgentIdentity: 'human-agent-sip' },
        callerAudioEnabled: true,
      });
      await expect(harness.sessionStarted).resolves.toBeUndefined();
    } finally {
      await harness.session.close().catch(() => undefined);
    }
  });

  it('lets the abort win when the in-flight move fails', async () => {
    const controller = new AbortController();
    const harness = await startPendingMergeHarness(controller.signal);

    try {
      const reason = new Error('consult timed out');
      controller.abort(reason);

      harness.pendingMove.reject(new Error('move participant failed'));
      await expect(harness.merge).resolves.toBeUndefined();
      const outcome = await harness.taskSettled;
      expect(outcome).toEqual({
        type: 'failed',
        error: reason,
        callerAudioEnabled: true,
      });
      await expect(harness.sessionStarted).resolves.toBeUndefined();
    } finally {
      await harness.session.close().catch(() => undefined);
    }
  });

  it('resolves a successful run() without waiting for consult teardown', async () => {
    const controller = new AbortController();
    const harness = await startPendingMergeHarness(controller.signal);

    try {
      const pendingShutdown = createDeferred();
      harness.shutdown.mockReturnValue(pendingShutdown.promise);

      harness.pendingMove.resolve();
      await expect(harness.merge).resolves.toBeUndefined();

      // Success hands control back immediately, with caller I/O restored,
      // even though the consult session is still shutting down.
      await expect(harness.taskSettled).resolves.toEqual({
        type: 'completed',
        value: { humanAgentIdentity: 'human-agent-sip' },
        callerAudioEnabled: true,
      });
      expect(harness.shutdown).toHaveBeenCalled();

      pendingShutdown.resolve();
    } finally {
      await harness.session.close().catch(() => undefined);
    }
  });

  it('holds a failed run() and caller I/O until the human agent session shutdown finishes', async () => {
    const controller = new AbortController();
    const harness = await startPendingMergeHarness(controller.signal);

    try {
      const pendingShutdown = createDeferred();
      harness.shutdown.mockReturnValue(pendingShutdown.promise);

      const reason = new Error('consult timed out');
      controller.abort(reason);
      harness.pendingMove.reject(new Error('move participant failed'));
      await expect(harness.merge).resolves.toBeUndefined();
      await vi.waitFor(() => expect(harness.shutdown).toHaveBeenCalled());

      const taskSettledSpy = vi.fn();
      void harness.taskSettled.then(taskSettledSpy);
      await Promise.resolve();
      await Promise.resolve();
      // A failed run() is the teardown boundary: the result is known, but it
      // must not settle while the human agent session is still closing —
      // and caller I/O stays disabled so the resumed agent cannot react to
      // the caller before the application has the outcome.
      expect(taskSettledSpy).not.toHaveBeenCalled();
      expect(harness.session.output.audioEnabled).toBe(false);

      pendingShutdown.resolve();
      await expect(harness.taskSettled).resolves.toEqual({
        type: 'failed',
        error: reason,
        callerAudioEnabled: true,
      });
    } finally {
      await harness.session.close().catch(() => undefined);
    }
  });

  it('deletes the consult room when a cancelled dial answers late', async () => {
    const pendingRoomConnection = createDeferred();
    const roomConnect = vi
      .spyOn(Room.prototype, 'connect')
      .mockReturnValue(pendingRoomConnection.promise);
    vi.spyOn(Room.prototype, 'disconnect').mockResolvedValue(undefined);
    const controller = new AbortController();
    const harness = startTaskHarness({ abortSignal: controller.signal });

    try {
      await harness.onEnterStarted;
      await vi.waitFor(() => expect(roomConnect).toHaveBeenCalledOnce());

      // Mocked only after the caller session is live: a prototype-level start
      // mock applied earlier would stub the caller session's own start.
      vi.spyOn(AgentSession.prototype, 'start').mockResolvedValue(undefined);
      let answerDial!: (value: unknown) => void;
      const dialPromise = new Promise((resolve) => {
        answerDial = resolve;
      });
      const dial = vi
        .spyOn(SipClient.prototype, 'createSipParticipant')
        .mockReturnValue(dialPromise as never);

      pendingRoomConnection.resolve();
      await vi.waitFor(() => expect(dial).toHaveBeenCalledOnce());

      controller.abort(new Error('consult timed out'));
      await expect(harness.taskSettled).resolves.toMatchObject({
        type: 'failed',
      });
      expect(harness.deleteRoom).not.toHaveBeenCalled();

      // The server request cannot be aborted; a dial that answers after
      // cleanup can recreate the consult room, so the task deletes it again.
      answerDial({});
      await vi.waitFor(() =>
        expect(harness.deleteRoom).toHaveBeenCalledWith('caller-room-human-agent'),
      );
      await expect(harness.sessionStarted).resolves.toBeUndefined();
    } finally {
      await harness.session.close().catch(() => undefined);
    }
  });
});
