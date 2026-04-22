// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { getJobContext } from '../../job.js';
import { RealtimeModel, type ToolContext, tool } from '../../llm/index.js';
import { log } from '../../log.js';
import { Future, waitForAbort } from '../../utils.js';
import {
  AgentSessionEventTypes,
  type CloseEvent,
  type SpeechCreatedEvent,
} from '../../voice/events.js';
import type { RunContext, UnknownUserData } from '../../voice/run_context.js';
import type { SpeechHandle } from '../../voice/speech_handle.js';

// Ref: python livekit-agents/livekit/agents/beta/tools/end_call.py - 11-25 lines
const END_CALL_DESCRIPTION = `
Ends the current call and disconnects immediately.

Call when:
- The user clearly indicates they are done (e.g., "that's all, bye").
- The agent determines the conversation is complete and should end.

Do not call when:
- The user asks to pause, hold, or transfer.
- Intent is unclear.

This is the final action the agent can take.
Once called, no further interaction is possible with the user.
Don't generate any other text or response when the tool is called.
`;

export interface EndCallToolCalledEvent<UserData = UnknownUserData> {
  ctx: RunContext<UserData>;
  arguments: Record<string, never>;
}

export interface EndCallToolCompletedEvent<UserData = UnknownUserData> {
  ctx: RunContext<UserData>;
  output: string | null;
}

export interface EndCallToolOptions<UserData = UnknownUserData> {
  extraDescription?: string;
  deleteRoom?: boolean;
  endInstructions?: string | null;
  onToolCalled?: (event: EndCallToolCalledEvent<UserData>) => void | Promise<void>;
  onToolCompleted?: (event: EndCallToolCompletedEvent<UserData>) => void | Promise<void>;
}

export class EndCallTool<UserData = UnknownUserData> {
  readonly tools: ToolContext<UserData>;

  private readonly deleteRoom: boolean;
  private readonly endInstructions: string | null;
  private readonly onToolCalled?: (event: EndCallToolCalledEvent<UserData>) => void | Promise<void>;
  private readonly onToolCompleted?: (
    event: EndCallToolCompletedEvent<UserData>,
  ) => void | Promise<void>;
  private shutdownController?: AbortController;

  constructor({
    extraDescription = '',
    deleteRoom = true,
    endInstructions = 'say goodbye to the user',
    onToolCalled,
    onToolCompleted,
  }: EndCallToolOptions<UserData> = {}) {
    this.deleteRoom = deleteRoom;
    this.endInstructions = endInstructions;
    this.onToolCalled = onToolCalled;
    this.onToolCompleted = onToolCompleted;

    // Ref: python livekit-agents/livekit/agents/beta/tools/end_call.py - 28-62 lines
    this.tools = {
      end_call: tool<UserData, string | null>({
        description: `${END_CALL_DESCRIPTION}\n${extraDescription}`,
        execute: async (_args, { ctx }) => this.endCall(ctx),
      }),
    };
  }

  // Ref: python livekit-agents/livekit/agents/beta/tools/end_call.py - 64-91 lines
  private async endCall(ctx: RunContext<UserData>): Promise<string | null> {
    log().debug('end_call tool called');
    const llm = ctx.session.currentAgent.getActivityOrThrow().llm;

    ctx.speechHandle.addDoneCallback(() => {
      if (!(llm instanceof RealtimeModel) || !llm.capabilities.autoToolReplyGeneration) {
        ctx.session.shutdown();
        return;
      }

      this.startDelayedSessionShutdown(ctx);
    });

    ctx.session.once(AgentSessionEventTypes.Close, this.handleSessionClose);

    if (this.onToolCalled) {
      await this.onToolCalled({ ctx, arguments: {} });
    }

    const completedEvent = {
      ctx,
      output: this.endInstructions,
    } satisfies EndCallToolCompletedEvent<UserData>;

    if (this.onToolCompleted) {
      await this.onToolCompleted(completedEvent);
    }

    return completedEvent.output;
  }

  private startDelayedSessionShutdown(ctx: RunContext<UserData>): void {
    this.shutdownController?.abort();

    const controller = new AbortController();
    this.shutdownController = controller;

    void this.delayedSessionShutdown(ctx, controller.signal).finally(() => {
      if (this.shutdownController === controller) {
        this.shutdownController = undefined;
      }
    });
  }

  // Ref: python livekit-agents/livekit/agents/beta/tools/end_call.py - 93-109 lines
  private async delayedSessionShutdown(
    ctx: RunContext<UserData>,
    signal: AbortSignal,
  ): Promise<void> {
    const speechCreatedFuture = new Future<SpeechHandle>();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const onSpeechCreated = (event: SpeechCreatedEvent): void => {
      if (!speechCreatedFuture.done) {
        speechCreatedFuture.resolve(event.speechHandle);
      }
    };

    ctx.session.on(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);

    try {
      const replySpeechHandle = await Promise.race([
        speechCreatedFuture.await,
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), 5000);
        }),
        waitForAbort(signal).then(() => undefined),
      ]);

      if (!replySpeechHandle) {
        if (signal.aborted) {
          return;
        }
        log().warn('tool reply timed out, shutting down session');
      } else {
        await Promise.race([replySpeechHandle.waitForPlayout(), waitForAbort(signal)]);
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      ctx.session.off(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
    }

    if (!signal.aborted) {
      ctx.session.shutdown();
    }
  }

  // Ref: python livekit-agents/livekit/agents/beta/tools/end_call.py - 111-129 lines
  private handleSessionClose = (event: CloseEvent): void => {
    this.shutdownController?.abort();
    this.shutdownController = undefined;

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

    jobCtx.shutdown(event.reason);
  };
}
