// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import { type GenerationCreatedEvent, RealtimeModel, RealtimeSession } from '../llm/realtime.js';
import { ToolContext, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput, type PlaybackFinishedEvent } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

const TOOL_CALL_ID = 'call_lookup';

function stream<T>(...items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

function frame(): AudioFrame {
  return new AudioFrame(new Int16Array(480), 24_000, 1, 480);
}

class InterruptingOutput extends AudioOutput {
  onFirstFrame?: () => void;
  readonly firstFrame = new Future<void>();
  private firstFrameSeen = false;

  constructor(private finishOnFlush = true) {
    super(24_000);
  }

  override async captureFrame(audioFrame: AudioFrame): Promise<void> {
    await super.captureFrame(audioFrame);
    this.onPlaybackStarted(Date.now());
    if (!this.firstFrameSeen) {
      this.firstFrameSeen = true;
      this.firstFrame.resolve();
      this.onFirstFrame?.();
    }
  }

  override flush(): void {
    super.flush();
    if (this.finishOnFlush) this.finishPlayout(false);
  }

  override clearBuffer(): void {
    this.finishPlayout(true);
  }

  private finishPlayout(interrupted: boolean): void {
    if (this.pendingPlayoutSegments === 0) return;
    const event: PlaybackFinishedEvent = {
      playbackPosition: 0.02,
      interrupted,
    };
    this.onPlaybackFinished(event);
  }
}

class PipelineAgent extends Agent {
  constructor(execute: () => Promise<string>) {
    super({
      instructions: 'test',
      tools: { lookup: tool({ description: 'Look something up.', execute }) },
    });
  }

  override async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    return stream(frame());
  }
}

class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();

  get chatCtx(): ChatContext {
    return this._chatCtx;
  }
  get tools(): ToolContext {
    return this._tools;
  }
  async updateInstructions(_instructions: string): Promise<void> {}
  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    this._chatCtx = chatCtx.copy();
  }
  async updateTools(tools: ToolContext): Promise<void> {
    this._tools = tools.copy();
  }
  updateOptions(): void {}
  pushAudio(_frame: AudioFrame): void {}
  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async truncate(): Promise<void> {}

  async generateReply(): Promise<GenerationCreatedEvent> {
    return {
      messageStream: stream({
        messageId: 'message-id',
        textStream: stream('let me check'),
        audioStream: stream(frame()),
        modalities: Promise.resolve(['audio', 'text']),
      }),
      functionStream: stream(
        FunctionCall.create({ callId: TOOL_CALL_ID, name: 'lookup', args: '{}' }),
      ),
      userInitiated: true,
      responseId: 'response-id',
    };
  }
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession = new FakeRealtimeSession(this);

  constructor() {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: true,
      audioOutput: true,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
    });
  }

  get model(): string {
    return 'fake-realtime';
  }
  session(): RealtimeSession {
    return this.activeSession;
  }
  async close(): Promise<void> {}
}

function outputs(chatCtx: ChatContext, callId: string) {
  return chatCtx.items.filter(
    (item) => item.type === 'function_call_output' && item.callId === callId,
  );
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

describe('interruption timeout tool release', () => {
  afterEach(() => vi.useRealTimers());

  it('releases a running realtime tool and keeps its final result', async () => {
    vi.useFakeTimers();
    const toolStarted = new Future<void>();
    const releaseTool = new Future<void>();
    const model = new FakeRealtimeModel();
    const session = new AgentSession({
      llm: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    const output = new InterruptingOutput(false);
    session.output.audio = output;
    const agent = new Agent({
      instructions: 'test',
      tools: {
        lookup: tool({
          description: 'Look something up.',
          execute: async () => {
            toolStarted.resolve();
            await releaseTool.await;
            return 'the fee is 10 dollars';
          },
        }),
      },
    });

    await session.start({ agent });
    try {
      const handle = session.generateReply();
      await toolStarted.await;
      handle.interrupt(true);
      output.clearBuffer();
      await vi.advanceTimersByTimeAsync(5_100);
      await handle.waitForPlayout();
      await flushMicrotasks();

      const released = outputs(model.activeSession.chatCtx, TOOL_CALL_ID);
      expect(released).toHaveLength(1);
      expect(released[0]!.output).toContain('still in progress');

      releaseTool.resolve();
      await flushMicrotasks();
      const final = outputs(model.activeSession.chatCtx, `${TOOL_CALL_ID}_final`);
      expect(final).toHaveLength(1);
      expect(final[0]!.output).toContain('the fee is 10 dollars');
    } finally {
      releaseTool.resolve();
      const closing = session.close();
      await vi.runAllTimersAsync();
      await closing;
    }
  });

  it('releases a running pipeline tool and keeps its final result', async () => {
    vi.useFakeTimers();
    const toolStarted = new Future<void>();
    const releaseTool = new Future<void>();
    const llm = new FakeLLM([
      {
        input: 'Look up my order',
        content: 'Let me check.',
        toolCalls: [{ name: 'lookup', args: {} }],
      },
    ]);
    const session = new AgentSession({ llm });
    const output = new InterruptingOutput(false);
    session.output.audio = output;
    const agent = new PipelineAgent(async () => {
      toolStarted.resolve();
      await releaseTool.await;
      return 'order 42 shipped';
    });

    await session.start({ agent });
    try {
      const handle = session.generateReply({ userInput: 'Look up my order' });
      await vi.runOnlyPendingTimersAsync();
      await Promise.all([toolStarted.await, output.firstFrame.await]);
      handle.interrupt(true);
      output.clearBuffer();
      await vi.advanceTimersByTimeAsync(5_100);
      await handle.waitForPlayout();
      await Promise.all(handle._tasks.map((task) => task.result.catch(() => undefined)));
      await flushMicrotasks();

      const released = outputs(agent.chatCtx, 'fake_call_0');
      expect(released).toHaveLength(1);
      expect(released[0]!.output).toContain('still in progress');

      releaseTool.resolve();
      await flushMicrotasks();
      const final = outputs(agent.chatCtx, 'fake_call_0_final');
      expect(final).toHaveLength(1);
      expect(final[0]!.output).toContain('order 42 shipped');
    } finally {
      releaseTool.resolve();
      const closing = session.close();
      await vi.runAllTimersAsync();
      await closing;
    }
  });
});
