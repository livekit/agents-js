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
export class EndCallTool<UserData = UnknownUserData> extends Toolset {
  private readonly deleteRoom: boolean;
  private readonly endInstructions: string | null;
  private readonly onToolCalled?: (event: EndCallToolCalledEvent<UserData>) => Promise<void> | void;
  private readonly onToolCompleted?: (
    event: EndCallToolCompletedEvent<UserData>,
  ) => Promise<void> | void;
  private shutdownSessionTimeout: NodeJS.Timeout | undefined;

  constructor({
    extraDescription = '',
    deleteRoom = true,
    endInstructions = 'say goodbye to the user',
    onToolCalled,
    onToolCompleted,
  }: EndCallToolOptions<UserData> = {}) {
    let instance!: EndCallTool<UserData>;
    const endCallTool = tool<UserData, string | undefined>({
      name: 'end_call',
      description: `${END_CALL_DESCRIPTION}\n${extraDescription}`,
      execute: async (_args, { ctx }) => instance.endCall(ctx),
    });

    super({ id: 'end_call', tools: [endCallTool] });
    instance = this;

    this.deleteRoom = deleteRoom;
    this.endInstructions = endInstructions;
    this.onToolCalled = onToolCalled;
    this.onToolCompleted = onToolCompleted;
  }

  private async endCall(ctx: RunContext<UserData>): Promise<string | undefined> {
    log().debug('end_call tool called');
    const llm = ctx.session.currentAgent.getActivityOrThrow().llm;

    ctx.speechHandle.addDoneCallback(() => {
      if (!(llm instanceof RealtimeModel) || !llm.capabilities.autoToolReplyGeneration) {
        ctx.session.shutdown();
        return;
      }

      this.delayedSessionShutdown(ctx);
    });

    ctx.session.once(AgentSessionEventTypes.Close, this.onSessionClose);

    if (this.onToolCalled) {
      await this.onToolCalled({ ctx, arguments: {} });
    }

    const completedEvent = {
      ctx,
      output:
        this.endInstructions === null
          ? undefined
          : ({ type: 'output', value: this.endInstructions } as const),
    };
    if (this.onToolCompleted) {
      await this.onToolCompleted(completedEvent);
    }

    return this.endInstructions ?? undefined;
  }

  private delayedSessionShutdown(ctx: RunContext<UserData>): void {
    const onSpeechCreated = (event: SpeechCreatedEvent) => {
      this.clearDelayedShutdown(ctx, onSpeechCreated);
      void event.speechHandle.waitForPlayout().finally(() => ctx.session.shutdown());
    };

    ctx.session.once(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
    this.shutdownSessionTimeout = setTimeout(() => {
      this.clearDelayedShutdown(ctx, onSpeechCreated);
      log().warn('tool reply timed out, shutting down session');
      ctx.session.shutdown();
    }, 5000);
  }

  private clearDelayedShutdown(
    ctx: RunContext<UserData>,
    onSpeechCreated: (event: SpeechCreatedEvent) => void,
  ): void {
    ctx.session.off(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
    if (this.shutdownSessionTimeout) {
      clearTimeout(this.shutdownSessionTimeout);
      this.shutdownSessionTimeout = undefined;
    }
  }

  private onSessionClose = (event: CloseEvent): void => {
    if (this.shutdownSessionTimeout) {
      clearTimeout(this.shutdownSessionTimeout);
      this.shutdownSessionTimeout = undefined;
    }

    const jobCtx = getJobContext(false);
    if (!jobCtx) {
      return;
    }

    if (this.deleteRoom) {
      jobCtx.addShutdownCallback(async () => {
        log().info('deleting the room because the user ended the call');
        await jobCtx.deleteRoom();
      });
    }

    jobCtx.shutdown(String(event.reason));
  };
}
