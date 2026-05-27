// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type EventEmitter, once } from 'node:events';
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
import type { AgentSession, AgentSessionCallbacks } from '../../voice/agent_session.js';
import { AgentSessionEventTypes } from '../../voice/events.js';
import type { RunContext, UnknownUserData } from '../../voice/run_context.js';

/** How long to wait for the agent's goodbye reply to play out before forcing shutdown. */
const END_CALL_REPLY_TIMEOUT = 5000;

/**
 * `events.once` typed against {@link AgentSessionCallbacks}, resolving to the event payload (e.g.
 * `CloseEvent`) — every session event is single-arg — instead of the raw `any[]` tuple. The cast
 * `events.once` forces is confined here.
 *
 * If `signal` aborts before the event fires, `events.once` rejects with an AbortError. Since these
 * waits are fire-and-forget (or race losers), an uncaught rejection would surface as an unhandled
 * rejection — so we absorb the abort and resolve to `undefined`, letting callers treat "aborted"
 * as a normal (typed) outcome. Other rejections (e.g. an emitter `error`) still propagate.
 */
function onceEvent<E extends keyof AgentSessionCallbacks>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callbacks don't depend on UserData
  session: AgentSession<any>,
  event: E,
  options?: { signal?: AbortSignal },
): Promise<Parameters<AgentSessionCallbacks[E]>[0] | undefined> {
  return (
    once(session as unknown as EventEmitter, event, options) as Promise<
      Parameters<AgentSessionCallbacks[E]>
    >
  ).then(
    ([payload]) => payload,
    (err) => {
      if (options?.signal?.aborted) return undefined;
      throw err;
    },
  );
}

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
export function createEndCallTool<UserData = UnknownUserData>({
  extraDescription = '',
  deleteRoom = true,
  endInstructions = 'say goodbye to the user',
  onToolCalled,
  onToolCompleted,
}: EndCallToolOptions<UserData> = {}): Toolset {
  // For a realtime LLM that generates the goodbye reply itself, wait for that reply to play out
  // (bounded by END_CALL_REPLY_TIMEOUT) before shutting down. `signal` is aborted when the call
  // ends or the toolset is torn down, which cancels whichever of the two races is still pending.
  const delayedSessionShutdown = async (
    session: AgentSession<UserData>,
    signal: AbortSignal,
  ): Promise<void> => {
    const speech = onceEvent(session, AgentSessionEventTypes.SpeechCreated, { signal }).then(
      (event) => event?.speechHandle,
    );
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

  return Toolset.create<UserData>({
    id: 'end_call',
    // `session` and `teardownSignal` are in lexical scope for the tool below — no state is stashed
    // between activation and a tool call. `teardownSignal` aborts when the toolset is torn down.
    tools: async ({ session, signal: teardownSignal }) => {
      const endCall = async (ctx: RunContext<UserData>): Promise<string | undefined> => {
        log().debug('end_call tool called');
        const llm = session.currentAgent.getActivityOrThrow().llm;

        // Lifetime of this invocation: aborts when the session closes, and also when the toolset
        // is torn down (via teardownSignal). All listeners/timers below are scoped to it.
        const controller = new AbortController();
        const signal = AbortSignal.any([teardownSignal, controller.signal]);

        void onceEvent(session, AgentSessionEventTypes.Close, { signal }).then((event) => {
          if (!event) return; // signal aborted before close fired (e.g. toolset torn down)
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
        });

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

      return [
        tool<UserData>({
          name: 'end_call',
          description: `${END_CALL_DESCRIPTION}\n${extraDescription}`,
          execute: async (_args, { ctx }) => endCall(ctx),
        }),
      ];
    },
  });
}
