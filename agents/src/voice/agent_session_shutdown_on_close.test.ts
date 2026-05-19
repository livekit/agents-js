// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceExecutor } from '../ipc/inference_executor.js';
import { JobContext, type JobProcess, type RunningJobInfo, runWithJobContext } from '../job.js';
import { AgentSession } from './agent_session.js';
import { CloseReason, createCloseEvent } from './events.js';
import { AgentSessionEventTypes } from './events.js';

// Regression coverage for issue #927:
// when the primary AgentSession closes because the remote participant
// disconnected, the surrounding JobContext must be shut down so the
// job process can drain and exit. Without this wiring the job stays
// alive until the parent worker SIGTERMs it (~60s after hangup).

function buildRoom() {
  return {
    name: 'room-927',
    on: vi.fn(),
    off: vi.fn(),
    isConnected: false,
    remoteParticipants: new Map(),
  } as unknown as Room;
}

function buildContext(onShutdown: (reason: string) => void) {
  const room = buildRoom();
  return new JobContext(
    {} as unknown as JobProcess,
    {
      acceptArguments: { name: 'agent', identity: 'agent', metadata: '' },
      job: { id: 'job-927', room: { name: 'room-927' } },
      url: 'wss://example.livekit.cloud',
      token: 'token',
      workerId: 'worker-927',
    } as unknown as RunningJobInfo,
    room,
    vi.fn(),
    onShutdown,
    {} as unknown as InferenceExecutor,
  );
}

describe('primary AgentSession close → JobContext shutdown', () => {
  let originalActiveHandles: number;

  beforeEach(() => {
    originalActiveHandles = (
      process as unknown as { _getActiveHandles: () => unknown[] }
    )._getActiveHandles().length;
  });

  afterEach(() => {
    // baseline check: handle count must not drift across tests
    const after = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles()
      .length;
    expect(after - originalActiveHandles).toBeLessThanOrEqual(2);
  });

  it('shuts down the job when the primary session closes via PARTICIPANT_DISCONNECTED', () => {
    const onShutdown = vi.fn();
    const ctx = buildContext(onShutdown);
    const session = new AgentSession();

    runWithJobContext(ctx, () => {
      ctx._primaryAgentSession = session;
      // simulate the wiring that start() installs
      AgentSession._attachPrimarySessionShutdownHook(session, ctx);
    });

    session.emit(
      AgentSessionEventTypes.Close,
      createCloseEvent(CloseReason.PARTICIPANT_DISCONNECTED, null),
    );

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledWith('primary_session_closed');
  });

  it('does not shut down the job when close reason is USER_INITIATED', () => {
    const onShutdown = vi.fn();
    const ctx = buildContext(onShutdown);
    const session = new AgentSession();

    runWithJobContext(ctx, () => {
      ctx._primaryAgentSession = session;
      AgentSession._attachPrimarySessionShutdownHook(session, ctx);
    });

    session.emit(AgentSessionEventTypes.Close, createCloseEvent(CloseReason.USER_INITIATED, null));

    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('does not shut down the job when close reason is JOB_SHUTDOWN', () => {
    const onShutdown = vi.fn();
    const ctx = buildContext(onShutdown);
    const session = new AgentSession();

    runWithJobContext(ctx, () => {
      ctx._primaryAgentSession = session;
      AgentSession._attachPrimarySessionShutdownHook(session, ctx);
    });

    session.emit(AgentSessionEventTypes.Close, createCloseEvent(CloseReason.JOB_SHUTDOWN, null));

    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('does not shut down the job when close reason is ERROR (out of scope for #927)', () => {
    const onShutdown = vi.fn();
    const ctx = buildContext(onShutdown);
    const session = new AgentSession();

    runWithJobContext(ctx, () => {
      ctx._primaryAgentSession = session;
      AgentSession._attachPrimarySessionShutdownHook(session, ctx);
    });

    session.emit(AgentSessionEventTypes.Close, createCloseEvent(CloseReason.ERROR, null));

    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('only fires once even if Close is emitted multiple times', () => {
    const onShutdown = vi.fn();
    const ctx = buildContext(onShutdown);
    const session = new AgentSession();

    runWithJobContext(ctx, () => {
      ctx._primaryAgentSession = session;
      AgentSession._attachPrimarySessionShutdownHook(session, ctx);
    });

    session.emit(
      AgentSessionEventTypes.Close,
      createCloseEvent(CloseReason.PARTICIPANT_DISCONNECTED, null),
    );
    session.emit(
      AgentSessionEventTypes.Close,
      createCloseEvent(CloseReason.PARTICIPANT_DISCONNECTED, null),
    );

    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('does not leak the Close listener after firing', () => {
    const onShutdown = vi.fn();
    const ctx = buildContext(onShutdown);
    const session = new AgentSession();

    runWithJobContext(ctx, () => {
      ctx._primaryAgentSession = session;
      AgentSession._attachPrimarySessionShutdownHook(session, ctx);
    });

    const before = session.listenerCount(AgentSessionEventTypes.Close);
    session.emit(
      AgentSessionEventTypes.Close,
      createCloseEvent(CloseReason.PARTICIPANT_DISCONNECTED, null),
    );
    const after = session.listenerCount(AgentSessionEventTypes.Close);

    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before - 1);
  });

  it('handles repeated session-create-close cycles without accumulating handles', () => {
    const onShutdown = vi.fn();
    const ctx = buildContext(onShutdown);

    const handlesBefore = (
      process as unknown as { _getActiveHandles: () => unknown[] }
    )._getActiveHandles().length;

    for (let i = 0; i < 5; i++) {
      const session = new AgentSession();
      runWithJobContext(ctx, () => {
        ctx._primaryAgentSession = session;
        AgentSession._attachPrimarySessionShutdownHook(session, ctx);
      });
      session.emit(
        AgentSessionEventTypes.Close,
        createCloseEvent(CloseReason.PARTICIPANT_DISCONNECTED, null),
      );
      session.removeAllListeners();
    }

    const handlesAfter = (
      process as unknown as { _getActiveHandles: () => unknown[] }
    )._getActiveHandles().length;

    // ctx.shutdown is called 5 times, all sessions are GC-eligible
    expect(onShutdown).toHaveBeenCalledTimes(5);
    expect(handlesAfter).toBeLessThanOrEqual(handlesBefore + 1);
  });

  it('does nothing when there is no JobContext (test/CLI scenario)', () => {
    const session = new AgentSession();
    expect(() => AgentSession._attachPrimarySessionShutdownHook(session, undefined)).not.toThrow();

    // still safe to emit Close
    session.emit(
      AgentSessionEventTypes.Close,
      createCloseEvent(CloseReason.PARTICIPANT_DISCONNECTED, null),
    );
  });

  it('simulates the job_proc_lazy_main close pipeline end-to-end', async () => {
    // Mirrors the wiring in agents/src/ipc/job_proc_lazy_main.ts:
    //   - onShutdown sets `shutdown = true` and emits `close` on a shared event
    //   - the awaiting code (`once(closeEvent, 'close')`) wakes up and the
    //     task continues to its `joinFuture.resolve()`.
    // With the fix wired, participant-disconnect → primary session close
    // → ctx.shutdown → closeEvent fires → joinFuture resolves promptly.
    const closeEvent = new EventEmitter();
    let shutdown = false;
    let shutdownReason = '';
    const joinFuture = new Promise<void>((resolve) => {
      closeEvent.once('close', (_drain: boolean, reason: string) => {
        shutdown = true;
        shutdownReason = reason ?? '';
        resolve();
      });
    });

    const onShutdown = (reason: string) => {
      closeEvent.emit('close', true, reason);
    };
    const ctx = buildContext(onShutdown);
    const session = new AgentSession();

    runWithJobContext(ctx, () => {
      ctx._primaryAgentSession = session;
      AgentSession._attachPrimarySessionShutdownHook(session, ctx);
    });

    // Simulate room_io closing the session on participant disconnect.
    session.emit(
      AgentSessionEventTypes.Close,
      createCloseEvent(CloseReason.PARTICIPANT_DISCONNECTED, null),
    );

    // joinFuture should resolve essentially instantly — well within the
    // 60s SIGTERM window the bug report observed.
    const settled = await Promise.race([
      joinFuture.then(() => 'resolved' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1000)),
    ]);

    expect(settled).toBe('resolved');
    expect(shutdown).toBe(true);
    expect(shutdownReason).toBe('primary_session_closed');
  });
});
