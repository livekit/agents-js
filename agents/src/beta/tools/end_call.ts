// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import { setTimeout as waitFor } from 'node:timers/promises';
import { getJobContext } from '../../job.js';
import {
  RealtimeModel,
  type ToolCalledEvent,
  type ToolCompletedEvent,
  Toolset,
  tool,
} from '../../llm/index.js';
import { log } from '../../log.js';
import type { AgentSession } from '../../voice/agent_session.js';
import {
  AgentSessionEventTypes,
  type CloseEvent,
  type SpeechCreatedEvent,
} from '../../voice/events.js';
import type { RunContext, UnknownUserData } from '../../voice/run_context.js';

/** How long to wait for the agent's goodbye reply to play out before forcing shutdown. */
const END_CALL_REPLY_TIMEOUT = 5000;

export const END_CALL_DESCRIPTION = `
Ends the current call and disconnects immediately.

Call when:
- The user clearly indicates they are done (e.g., "that's all, bye").

Do not call when:
- The user asks to pause, hold, or transfer.
- Intent is unclear.

This is the final action the agent can take.
Once called, no further interaction is possible with the user.
Don't generate any other text or response when the tool is called.
`;

export type EndCallToolCalledEvent<UserData = UnknownUserData> = ToolCalledEvent<UserData>;

export type EndCallToolCompletedEvent<UserData = UnknownUserData> = ToolCompletedEvent<UserData>;

export type EndCallToolOptions<UserData = UnknownUserData> = {
  /** Additional description to add to the end call tool. */
  extraDescription?: string;
  /**
   * Whether to delete the room when the user ends the call.
   * Deleting the room disconnects all remote users, including SIP callers.
   */
  deleteRoom?: boolean;
  /** Tool output to the LLM for generating the tool response. */
  endInstructions?: string | null;
  /** Callback to call when the tool is called. */
  onToolCalled?: (event: EndCallToolCalledEvent<UserData>) => Promise<void> | void;
  /** Callback to call when the tool is completed. */
  onToolCompleted?: (event: EndCallToolCompletedEvent<UserData>) => Promise<void> | void;
};

/**
 * Allows the agent to end the call and disconnect from the room.
 */
export function EndCallTool<UserData = UnknownUserData>({
  extraDescription = '',
  deleteRoom = true,
  endInstructions = 'say goodbye to the user',
  onToolCalled,
  onToolCompleted,
}: EndCallToolOptions<UserData> = {}): Toolset {
  // Captured from setup(): aborts when the toolset is torn down, so any per-invocation listener
  // or timer wired to it detaches automatically instead of being unwound by hand.
  let teardownSignal: AbortSignal | undefined;

  // For a realtime LLM that generates the goodbye reply itself, wait for that reply to play out
  // (bounded by END_CALL_REPLY_TIMEOUT) before shutting down. `signal` is aborted when the call
  // ends or the toolset is torn down, which cancels whichever of the two races is still pending.
  const delayedSessionShutdown = async (
    session: AgentSession<UserData>,
    signal: AbortSignal,
  ): Promise<void> => {
    const speech = once(session, AgentSessionEventTypes.SpeechCreated, { signal })
      .then((args) => (args[0] as SpeechCreatedEvent).speechHandle)
      .catch(() => undefined);
    const timeout = waitFor(END_CALL_REPLY_TIMEOUT, 'timeout' as const, { signal }).catch(
      () => undefined,
    );

    const winner = await Promise.race([speech, timeout]);
    if (signal.aborted) return; // session already closed or toolset torn down

    if (winner === 'timeout') {
      log().warn('tool reply timed out, shutting down session');
      session.shutdown();
    } else if (winner) {
      await winner.waitForPlayout();
      session.shutdown();
    }
  };

  const endCall = async (ctx: RunContext<UserData>): Promise<string | undefined> => {
    log().debug('end_call tool called');
    const { session } = ctx;
    const llm = session.currentAgent.getActivityOrThrow().llm;

    // Lifetime of this invocation: aborts when the session closes, and also when the toolset is
    // torn down (via teardownSignal). All listeners/timers below are scoped to it.
    const controller = new AbortController();
    const signal = teardownSignal
      ? AbortSignal.any([teardownSignal, controller.signal])
      : controller.signal;

    once(session, AgentSessionEventTypes.Close, { signal })
      .then((args) => {
        const event = args[0] as CloseEvent;
        controller.abort(); // stop the delayed-shutdown race

        const jobCtx = getJobContext(false);
        if (!jobCtx) return;

        if (deleteRoom) {
          jobCtx.addShutdownCallback(async () => {
            log().info('deleting the room because the user ended the call');
            await jobCtx.deleteRoom();
          });
        }

        jobCtx.shutdown(String(event.reason));
      })
      .catch(() => undefined); // toolset torn down before the session closed

    ctx.speechHandle.addDoneCallback(() => {
      if (!(llm instanceof RealtimeModel) || !llm.capabilities.autoToolReplyGeneration) {
        session.shutdown();
        return;
      }

      void delayedSessionShutdown(session, signal);
    });

    if (onToolCalled) {
      await onToolCalled({ ctx, arguments: {} });
    }

    const completedEvent = {
      ctx,
      output:
        endInstructions === null
          ? undefined
          : ({ type: 'output', value: endInstructions } as const),
    };
    if (onToolCompleted) {
      await onToolCompleted(completedEvent);
    }

    return endInstructions ?? undefined;
  };

  return Toolset.create<UserData>({
    id: 'end_call',
    setup: async ({ signal }) => {
      teardownSignal = signal;
    },
    tools: [
      tool<UserData, string | undefined>({
        name: 'end_call',
        description: `${END_CALL_DESCRIPTION}\n${extraDescription}`,
        execute: async (_args, { ctx }) => endCall(ctx),
      }),
    ],
  });
}
