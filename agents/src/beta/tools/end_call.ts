// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, getJobContext } from '../../job.js';
import { RealtimeModel, type ToolContext, type ToolOptions, tool } from '../../llm/index.js';
import {
  AgentSessionEventTypes,
  type CloseEvent,
  type SpeechCreatedEvent,
} from '../../voice/events.js';
import type { RunContext, UnknownUserData } from '../../voice/run_context.js';
import type { SpeechHandle } from '../../voice/speech_handle.js';

export const END_CALL_DESCRIPTION = `
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

export type EndCallToolCalledEvent<UserData = UnknownUserData> = {
  ctx: RunContext<UserData>;
  arguments: Record<string, never>;
};

export type EndCallToolCompletedEvent<UserData = UnknownUserData> = {
  ctx: RunContext<UserData>;
  output: string | undefined;
};

export interface EndCallToolOptions<UserData = UnknownUserData> {
  /**
   * Additional description to append to the end call tool.
   */
  extraDescription?: string;

  /**
   * Whether to delete the room when the call ends.
   *
   * Deleting the room disconnects all remote users, including SIP callers.
   */
  deleteRoom?: boolean;

  /**
   * Tool output to the LLM for generating the final response.
   *
   * Set to `null` to skip generating a final tool response.
   */
  endInstructions?: string | null;

  /**
   * Called when the tool starts.
   */
  onToolCalled?: (event: EndCallToolCalledEvent<UserData>) => Promise<void>;

  /**
   * Called after the tool has produced its output.
   */
  onToolCompleted?: (event: EndCallToolCompletedEvent<UserData>) => Promise<void>;
}

type ToolResponseSpeechWaiter = {
  promise: Promise<SpeechHandle>;
  startTimeout: () => void;
};

/**
 * Tool that lets an agent gracefully end the current call.
 *
 * The tool returns `endInstructions` so the LLM can produce a final response,
 * then shuts down the session and job after the final speech has played out.
 */
export class EndCallTool<UserData = UnknownUserData> {
  readonly tools: ToolContext<UserData>;
  private readonly deleteRoom: boolean;
  private readonly endInstructions: string | undefined;
  private readonly onToolCalled?: (event: EndCallToolCalledEvent<UserData>) => Promise<void>;
  private readonly onToolCompleted?: (event: EndCallToolCompletedEvent<UserData>) => Promise<void>;
  private readonly handledSpeechHandles = new WeakSet<SpeechHandle>();

  constructor(options: EndCallToolOptions<UserData> = {}) {
    const {
      extraDescription = '',
      deleteRoom = true,
      endInstructions = 'say goodbye to the user',
      onToolCalled,
      onToolCompleted,
    } = options;

    this.deleteRoom = deleteRoom;
    this.endInstructions = endInstructions === null ? undefined : endInstructions;
    this.onToolCalled = onToolCalled;
    this.onToolCompleted = onToolCompleted;
    this.tools = {
      end_call: tool<UserData, string | undefined>({
        description: extraDescription
          ? `${END_CALL_DESCRIPTION}\n${extraDescription}`
          : END_CALL_DESCRIPTION,
        execute: async (_, opts) => this.endCall(opts),
      }),
    };
  }

  private async endCall({ ctx }: ToolOptions<UserData>): Promise<string | undefined> {
    if (this.handledSpeechHandles.has(ctx.speechHandle)) {
      return this.endInstructions;
    }
    this.handledSpeechHandles.add(ctx.speechHandle);

    const llm = ctx.session.currentAgent.getActivityOrThrow().llm;
    const shouldWaitForToolResponse =
      this.endInstructions !== undefined &&
      llm instanceof RealtimeModel &&
      llm.capabilities.autoToolReplyGeneration;
    const toolResponseSpeech = shouldWaitForToolResponse
      ? this.watchForToolResponseSpeech(ctx)
      : undefined;
    const jobCtx = getJobContext(false);

    ctx.session.once(AgentSessionEventTypes.Close, (event) => {
      this.onSessionClose(event, jobCtx);
    });

    ctx.speechHandle.addDoneCallback(() => {
      if (toolResponseSpeech) {
        void this.shutdownAfterToolResponse(ctx, toolResponseSpeech);
      } else {
        this.shutdownSession(ctx);
      }
    });

    await this.onToolCalled?.({ ctx, arguments: {} });

    const completedEvent = {
      ctx,
      output: this.endInstructions,
    };
    await this.onToolCompleted?.(completedEvent);

    return completedEvent.output;
  }

  private async shutdownAfterToolResponse(
    ctx: RunContext<UserData>,
    toolResponseSpeech: ToolResponseSpeechWaiter,
  ) {
    try {
      toolResponseSpeech.startTimeout();
      const speechHandle = await toolResponseSpeech.promise;
      await speechHandle.waitForPlayout();
    } catch {
      // If no separate tool response is created, fall through and shut down.
    } finally {
      this.shutdownSession(ctx);
    }
  }

  private watchForToolResponseSpeech(ctx: RunContext<UserData>): ToolResponseSpeechWaiter {
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;
    let rejectPromise: (reason: Error) => void = () => {};
    let cleanup = () => {};

    const promise = new Promise<SpeechHandle>((resolve, reject) => {
      rejectPromise = reject;

      const onSpeechCreated = (event: SpeechCreatedEvent) => {
        if (event.userInitiated) return;

        cleanup();
        settled = true;
        resolve(event.speechHandle);
      };

      cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        ctx.session.off(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
      };

      ctx.session.on(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
    });

    return {
      promise,
      startTimeout: () => {
        if (settled || timeout) return;
        timeout = setTimeout(() => {
          settled = true;
          cleanup();
          rejectPromise(new Error('tool response timed out'));
        }, 5000);
      },
    };
  }

  private shutdownSession(ctx: RunContext<UserData>) {
    ctx.session.shutdown({ drain: true, reason: 'end_call' });
  }

  private onSessionClose(event: CloseEvent, jobCtx: JobContext | undefined) {
    if (!jobCtx) {
      return;
    }

    if (this.deleteRoom) {
      jobCtx.addShutdownCallback(() => jobCtx.deleteRoom());
    }

    jobCtx.shutdown(event.reason);
  }
}
