// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput, type PlaybackFinishedEvent } from './io.js';

initializeLogger({ pretty: false, level: 'silent' });

const TOOL_CALL_ID = 'call_lookup_order';

function stream<T>(...items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

const PLAYBACK_FINISHED: PlaybackFinishedEvent = {
  playbackPosition: 0.02,
  interrupted: false,
};

function frame(): AudioFrame {
  const samples = 480;
  return new AudioFrame(new Int16Array(samples), 24000, 1, samples);
}

class DelayedCleanupAudioOutput extends AudioOutput {
  readonly initialWaitEntered = new Future<void>();
  readonly cleanupWaitEntered = new Future<void>();

  private waitCount = 0;
  private initialPlayout = new Future<PlaybackFinishedEvent>();
  private cleanupPlayout = new Future<PlaybackFinishedEvent>();

  constructor() {
    super(24000);
  }

  override async captureFrame(audioFrame: AudioFrame): Promise<void> {
    await super.captureFrame(audioFrame);
    this.onPlaybackStarted(Date.now());
  }

  override async waitForPlayout(): Promise<PlaybackFinishedEvent> {
    this.waitCount += 1;
    if (this.waitCount === 1) {
      this.initialWaitEntered.resolve();
      return this.initialPlayout.await;
    }
    if (this.waitCount === 2) {
      this.cleanupWaitEntered.resolve();
      return this.cleanupPlayout.await;
    }
    return PLAYBACK_FINISHED;
  }

  override clearBuffer(): void {}

  releaseCleanup(): void {
    if (!this.cleanupPlayout.done) {
      this.cleanupPlayout.resolve({ ...PLAYBACK_FINISHED, interrupted: true });
    }
  }

  releaseAll(): void {
    if (!this.initialPlayout.done) {
      this.initialPlayout.resolve({ ...PLAYBACK_FINISHED, interrupted: true });
    }
    this.releaseCleanup();
  }
}

/** Emits one text message and optionally one tool call per generation. */
class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();
  includeTool = true;

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
  updateOptions(_options: { toolChoice?: ToolChoice | null }): void {}
  pushAudio(_frame: AudioFrame): void {}
  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async truncate(): Promise<void> {}

  async generateReply(): Promise<GenerationCreatedEvent> {
    return {
      messageStream: stream({
        messageId: 'message-1',
        textStream: stream('Let me check that.'),
        audioStream: stream<AudioFrame>(),
        modalities: Promise.resolve(['text']),
      }),
      functionStream: this.includeTool
        ? stream(FunctionCall.create({ callId: TOOL_CALL_ID, name: 'lookup_order', args: '{}' }))
        : stream<FunctionCall>(),
      userInitiated: true,
      responseId: 'response-1',
    };
  }
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession = new FakeRealtimeSession(this);

  constructor() {
    // autoToolReplyGeneration keeps the run to a single generation.
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: true,
      audioOutput: false,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
    } satisfies RealtimeCapabilities);
  }

  get model(): string {
    return 'fake-realtime';
  }
  session(): RealtimeSession {
    return this.activeSession;
  }
  async close(): Promise<void> {}
}

describe('Realtime tool output commit', () => {
  it('restores audio interruption after a reply without tools', async () => {
    const model = new FakeRealtimeModel();
    model.activeSession.includeTool = false;
    const session = new AgentSession({
      llm: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    const agent = new Agent({ instructions: 'test' });

    await session.start({ agent });
    const activity = session._activity as unknown as {
      isInterruptionDetectionEnabled: boolean;
      isInterruptionByAudioActivityEnabled: boolean;
    };
    activity.isInterruptionDetectionEnabled = true;
    activity.isInterruptionByAudioActivityEnabled = false;

    try {
      await session.generateReply().waitForPlayout();
      await vi.waitFor(() => expect(activity.isInterruptionByAudioActivityEnabled).toBe(true));
    } finally {
      await session.close();
    }
  });

  it('ends active speech before waiting for a tool', async () => {
    const toolStarted = new Future<void>();
    const releaseTool = new Future<void>();
    const toolFinished = new Future<void>();

    const session = new AgentSession({
      llm: new FakeRealtimeModel(),
      vad: null,
      turnHandling: { turnDetection: null },
    });
    const agent = new Agent({
      instructions: 'test',
      tools: {
        lookup_order: tool({
          description: 'x',
          execute: async () => {
            toolStarted.resolve();
            await releaseTool.await;
            toolFinished.resolve();
            return 'ships tomorrow';
          },
        }),
      },
    });

    await session.start({ agent });
    const speech = session.generateReply();
    await toolStarted.await;
    try {
      await vi.waitFor(() => expect(session.agentState).toBe('thinking'));
    } finally {
      releaseTool.resolve();
      await toolFinished.await;
      await speech.waitForPlayout();
      await session.close();
    }
  });

  it('ignores delayed cleanup while a newer reply waits for a tool', async () => {
    vi.useFakeTimers();
    const output = new DelayedCleanupAudioOutput();
    const toolStarted = new Future<void>();
    const releaseTool = new Future<void>();
    const session = new AgentSession({
      llm: new FakeRealtimeModel(),
      vad: null,
      userAwayTimeout: 15,
      turnHandling: { turnDetection: null },
    });
    session.output.audio = output;
    const agent = new Agent({
      instructions: 'test',
      tools: {
        lookup_order: tool({
          description: 'x',
          execute: async () => {
            toolStarted.resolve();
            await releaseTool.await;
            return 'ships tomorrow';
          },
        }),
      },
    });

    let currentSpeech: ReturnType<AgentSession['generateReply']> | undefined;
    await session.start({ agent });
    try {
      const staleSpeech = session.say('stale speech', {
        audio: stream(frame()),
        addToChatCtx: false,
      });
      const staleTask = staleSpeech._tasks[0]!;
      await output.initialWaitEntered.await;
      expect(session.agentState).toBe('speaking');

      session.interrupt();
      await output.cleanupWaitEntered.await;
      currentSpeech = session.generateReply();

      await vi.advanceTimersByTimeAsync(5000);
      await toolStarted.await;
      await vi.waitFor(() => {
        expect(session.agentState).toBe('thinking');
        expect(session._activity?.currentSpeech).toBeUndefined();
      });

      output.releaseCleanup();
      await staleTask.result.catch(() => undefined);

      expect(session.agentState).toBe('thinking');
      await vi.advanceTimersByTimeAsync(15_001);
      expect(session.userState).toBe('listening');
    } finally {
      releaseTool.resolve();
      output.releaseAll();
      await currentSpeech?.waitForPlayout();
      const closeTask = session.close();
      await vi.runAllTimersAsync();
      await closeTask;
      vi.useRealTimers();
    }
  });

  // Regression: the realtime path pushed tool outputs only into the copy sent to
  // the provider and into `session.history`, never into `agent._chatCtx`. That left
  // the agent context with a `function_call` and no matching output, so history
  // summarization (which distills tool results) and handoff merges saw a dangling
  // call. Python commits both (agent_activity.py `_upsert_item`).
  it('commits tool outputs to the agent chat context', async () => {
    const session = new AgentSession({
      llm: new FakeRealtimeModel(),
      vad: null,
      turnHandling: { turnDetection: null },
    });
    const agent = new Agent({
      instructions: 'test',
      tools: { lookup_order: tool({ description: 'x', execute: async () => 'ships tomorrow' }) },
    });

    await session.start({ agent });
    try {
      await session.generateReply().waitForPlayout();
      // The tool runs as a background speech, so the output lands after playout.
      await vi.waitFor(() =>
        expect(agent.chatCtx.items.some((i) => i.type === 'function_call_output')).toBe(true),
      );
    } finally {
      await session.close();
    }

    const items = agent.chatCtx.items;
    const call = items.find((i) => i.type === 'function_call');
    const output = items.find((i) => i.type === 'function_call_output');

    expect(call?.callId).toBe(TOOL_CALL_ID);
    expect(output?.callId).toBe(TOOL_CALL_ID);
    expect(output?.output).toBe(JSON.stringify('ships tomorrow'));
    // The output must follow its call so summarization renders them in order.
    expect(items.indexOf(output!)).toBeGreaterThan(items.indexOf(call!));
  });
});
