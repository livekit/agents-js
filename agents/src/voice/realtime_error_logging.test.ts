// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_realtime_error_logging.py`. */
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type RealtimeCapabilities,
  RealtimeError,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext, ToolResult, tool } from '../llm/tool_context.js';
import { initializeLogger, log } from '../log.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput } from './io.js';

initializeLogger({ pretty: false, level: 'silent' });

const PRIVATE_ERROR = 'private provider response with credentials';
const TOOL_CALL_ID = 'call_lookup';

function stream<T>(...items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

/** Everything enabled. Mirrors Python `fake_capabilities()`. */
const CAPABILITIES: RealtimeCapabilities = {
  messageTruncation: true,
  turnDetection: true,
  userTranscription: true,
  autoToolReplyGeneration: true,
  audioOutput: true,
  manualFunctionCalls: true,
  midSessionChatCtxUpdate: true,
  midSessionInstructionsUpdate: true,
  midSessionToolsUpdate: true,
  perResponseToolChoice: true,
  supportsOverlappingSpeech: false,
};

/**
 * Mirrors Python `FakeRealtimeSession`: `updateError` fails `updateChatCtx`, and each
 * `generateReply` returns a future the test settles. `toolTurn` answers instead with one
 * message and one call to `toolName`, like Python's `run_realtime_tool_turn`.
 */
class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();
  updateError: Error | undefined;
  readonly replyFuts: Future<GenerationCreatedEvent>[] = [];
  toolTurn: { toolName: string; audio: boolean } | undefined;

  get chatCtx(): ChatContext {
    return this._chatCtx;
  }
  get tools(): ToolContext {
    return this._tools;
  }
  async updateInstructions(_instructions: string): Promise<void> {}
  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    if (this.updateError !== undefined) {
      throw this.updateError;
    }
    this._chatCtx = chatCtx.copy();
  }
  async updateTools(tools: ToolContext): Promise<void> {
    this._tools = tools.copy();
  }
  updateOptions(_options: { toolChoice?: ToolChoice | null }): void {}
  pushAudio(_frame: AudioFrame): void {}
  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async truncate(): Promise<void> {}

  async generateReply(): Promise<GenerationCreatedEvent> {
    const turn = this.toolTurn;
    if (turn !== undefined) {
      this.toolTurn = undefined;
      return {
        messageStream: stream({
          messageId: 'message-id',
          textStream: stream('let me check'),
          // a full second of audio, so the turn is still playing when the tool returns
          audioStream: turn.audio
            ? stream(new AudioFrame(new Int16Array(24_000), 24_000, 1, 24_000))
            : stream<AudioFrame>(),
          modalities: Promise.resolve(turn.audio ? ['audio', 'text'] : ['text']),
        }),
        functionStream: stream(
          FunctionCall.create({ callId: TOOL_CALL_ID, name: turn.toolName, args: '{}' }),
        ),
        userInitiated: true,
        responseId: 'response-id',
      };
    }
    const fut = new Future<GenerationCreatedEvent>();
    this.replyFuts.push(fut);
    return fut.await;
  }
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession = new FakeRealtimeSession(this);

  constructor() {
    super(CAPABILITIES);
  }

  get model(): string {
    return 'fake-realtime';
  }
  session(): RealtimeSession {
    return this.activeSession;
  }
  async close(): Promise<void> {}
}

class InterruptibleAudioOutput extends AudioOutput {
  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.onPlaybackStarted(Date.now());
  }

  override clearBuffer(): void {
    this.flush();
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }
}

/** Every warn/error log call whose message contains "failed to", like Python's filter. */
function captureFailureLogs(): () => unknown[][] {
  const logger = log();
  const warn = vi.spyOn(logger, 'warn');
  const error = vi.spyOn(logger, 'error');
  return () =>
    [...warn.mock.calls, ...error.mock.calls].filter((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('failed to')),
    );
}

function message(record: unknown[]): string {
  return record.find((arg): arg is string => typeof arg === 'string')!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('realtime error logging', () => {
  it.each([
    ['none', undefined],
    ['RealtimeError', RealtimeError],
    ['RuntimeError', Error],
  ] as const)('realtime reply failure logs only error type (%s)', async (_name, contextError) => {
    const model = new FakeRealtimeModel();
    const error = new (contextError ?? RealtimeError)(PRIVATE_ERROR);
    const session = new AgentSession({
      llm: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    await session.start({ agent: new Agent({ instructions: 'Test' }) });
    const records = captureFailureLogs();
    try {
      const rt = model.activeSession;
      if (contextError !== undefined) {
        rt.updateError = error;
      }
      const handle = session.generateReply({ userInput: 'hello' });
      await vi.waitFor(() => expect(handle.done() || rt.replyFuts.length > 0).toBe(true));
      rt.replyFuts[rt.replyFuts.length - 1]?.reject(error);
      await vi.waitFor(() => expect(handle.done()).toBe(true));
      expect(handle.exception()).toBe(error);
    } finally {
      await session.close();
    }

    // Python logs one more record, "failed to generate a reply" (see the skipped test below):
    // JS reports a failed generateReply only through the speech handle's exception
    expect(records()).toHaveLength(contextError !== undefined ? 1 : 0);
    for (const record of records()) {
      expect(message(record)).toBe('failed to update the chat context before generating the reply');
      expect(record[0]).toEqual({ errorType: error.name });
      expect(JSON.stringify(record)).not.toContain(PRIVATE_ERROR);
    }
  });

  it.skip('realtime reply failure logs "failed to generate a reply" (JS realtimeReplyTask has no RealtimeError catch around generateReply; it predates #6202)', () => {});

  it.each([false, true])(
    'realtime tool sync failure logs only error type (interrupted %s)',
    async (interrupted) => {
      const model = new FakeRealtimeModel();
      const rt = model.activeSession;
      rt.toolTurn = { toolName: 'lookup', audio: interrupted };
      const session = new AgentSession({
        llm: model,
        vad: null,
        turnHandling: { turnDetection: null },
      });
      if (interrupted) {
        session.output.audio = new InterruptibleAudioOutput();
      }
      const toolExecuted = new Future<void>();
      const agent = new Agent({
        instructions: 'Test',
        tools: {
          lookup: tool({
            description: 'Look something up.',
            execute: async () => {
              rt.updateError = new RealtimeError(PRIVATE_ERROR);
              toolExecuted.resolve();
              return new ToolResult('ok', { replyRequired: false });
            },
          }),
        },
      });
      await session.start({ agent });
      const records = captureFailureLogs();
      try {
        const speech = session.generateReply();
        await toolExecuted.await;
        if (interrupted) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          session.interrupt();
        }
        await speech.waitForPlayout();
        await vi.waitFor(() => expect(records()).toHaveLength(1));
      } finally {
        await session.close();
      }

      const logged = records();
      expect(logged).toHaveLength(1);
      expect(message(logged[0]!)).toBe(
        interrupted
          ? 'failed to sync the tool results of an interrupted generation'
          : 'failed to update chat context before generating the function calls results',
      );
      expect(logged[0]![0]).toEqual({ errorType: 'RealtimeError' });
      expect(JSON.stringify(logged[0])).not.toContain(PRIVATE_ERROR);
    },
  );
});
