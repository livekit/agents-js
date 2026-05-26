// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { getJobContext } from '../../job.js';
import {
  RealtimeModel,
  type ToolCalledEvent,
  type ToolCompletedEvent,
  Toolset,
  tool,
} from '../../llm/index.js';
import { log } from '../../log.js';
import {
  AgentSessionEventTypes,
  type CloseEvent,
  type SpeechCreatedEvent,
} from '../../voice/events.js';
import type { RunContext, UnknownUserData } from '../../voice/run_context.js';

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
  let shutdownSessionTimeout: NodeJS.Timeout | undefined;

  const clearDelayedShutdown = (
    ctx: RunContext<UserData>,
    onSpeechCreated: (event: SpeechCreatedEvent) => void,
  ): void => {
    ctx.session.off(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
    if (shutdownSessionTimeout) {
      clearTimeout(shutdownSessionTimeout);
      shutdownSessionTimeout = undefined;
    }
  };

  const delayedSessionShutdown = (ctx: RunContext<UserData>): void => {
    const onSpeechCreated = (event: SpeechCreatedEvent) => {
      clearDelayedShutdown(ctx, onSpeechCreated);
      void event.speechHandle.waitForPlayout().finally(() => ctx.session.shutdown());
    };

    ctx.session.once(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
    shutdownSessionTimeout = setTimeout(() => {
      clearDelayedShutdown(ctx, onSpeechCreated);
      log().warn('tool reply timed out, shutting down session');
      ctx.session.shutdown();
    }, 5000);
  };

  const onSessionClose = (event: CloseEvent): void => {
    if (shutdownSessionTimeout) {
      clearTimeout(shutdownSessionTimeout);
      shutdownSessionTimeout = undefined;
    }

    const jobCtx = getJobContext(false);
    if (!jobCtx) {
      return;
    }

    if (deleteRoom) {
      jobCtx.addShutdownCallback(async () => {
        log().info('deleting the room because the user ended the call');
        await jobCtx.deleteRoom();
      });
    }

    jobCtx.shutdown(String(event.reason));
  };

  const endCall = async (ctx: RunContext<UserData>): Promise<string | undefined> => {
    log().debug('end_call tool called');
    const llm = ctx.session.currentAgent.getActivityOrThrow().llm;

    ctx.speechHandle.addDoneCallback(() => {
      if (!(llm instanceof RealtimeModel) || !llm.capabilities.autoToolReplyGeneration) {
        ctx.session.shutdown();
        return;
      }

      delayedSessionShutdown(ctx);
    });

    ctx.session.once(AgentSessionEventTypes.Close, onSessionClose);

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

  return Toolset.create({
    id: 'end_call',
    tools: [
      tool<UserData, string | undefined>({
        name: 'end_call',
        description: `${END_CALL_DESCRIPTION}\n${extraDescription}`,
        execute: async (_args, { ctx }) => endCall(ctx),
      }),
    ],
  });
}
