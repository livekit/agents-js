// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
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
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';

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

/** Emits one text message plus one tool call per generation. */
class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();

  constructor(
    model: RealtimeModel,
    private readonly keepTextStreamOpen: boolean = false,
  ) {
    super(model);
  }

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
    const textStream = this.keepTextStreamOpen
      ? new ReadableStream<string>({
          start(controller) {
            controller.enqueue('Let me check that.');
          },
        })
      : stream('Let me check that.');

    return {
      messageStream: stream({
        messageId: 'message-1',
        textStream,
        audioStream: stream<AudioFrame>(),
        modalities: Promise.resolve(['text']),
      }),
      functionStream: stream(
        FunctionCall.create({ callId: TOOL_CALL_ID, name: 'lookup_order', args: '{}' }),
      ),
      userInitiated: true,
      responseId: 'response-1',
    };
  }
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession: FakeRealtimeSession;

  constructor(options: { keepTextStreamOpen?: boolean } = {}) {
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
    this.activeSession = new FakeRealtimeSession(this, options.keepTextStreamOpen);
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

  it('commits completed tool outputs when realtime generation is interrupted', async () => {
    const llm = new FakeRealtimeModel({ keepTextStreamOpen: true });
    const session = new AgentSession({
      llm,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    const agent = new Agent({
      instructions: 'test',
      tools: { lookup_order: tool({ description: 'x', execute: async () => 'ships tomorrow' }) },
    });

    await session.start({ agent });
    try {
      const speech = session.generateReply();

      await vi.waitFor(() =>
        expect(
          speech.chatItems.some(
            (item) => item.type === 'function_call_output' && item.callId === TOOL_CALL_ID,
          ),
        ).toBe(true),
      );

      speech.interrupt();
      await speech.waitForPlayout();

      await vi.waitFor(() =>
        expect(
          llm.activeSession.chatCtx.items.some(
            (item) => item.type === 'function_call_output' && item.callId === TOOL_CALL_ID,
          ),
        ).toBe(true),
      );
    } finally {
      await session.close();
    }

    expect(
      agent.chatCtx.items.some(
        (item) => item.type === 'function_call_output' && item.callId === TOOL_CALL_ID,
      ),
    ).toBe(true);
  });
});
