// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext, type ChatItem, FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type MessageGeneration,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';

initializeLogger({ pretty: false, level: 'silent' });

function emptyStream<T>(): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.close();
    },
  });
}

function oneItemStream<T>(item: T): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.enqueue(item);
      controller.close();
    },
  });
}

const TOOL_CALL_ID = 'call_lookup_order';

/**
 * Emits a single tool call on the first generation, then plain text replies. The
 * second generation matters for `autoToolReplyGeneration: false`, where the
 * activity schedules its own reply speech after the tool results are committed.
 */
class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();
  private generations = 0;

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

  async generateReply(): Promise<GenerationCreatedEvent> {
    const isFirst = this.generations++ === 0;

    const message: MessageGeneration = {
      messageId: `message-${this.generations}`,
      textStream: oneItemStream(isFirst ? 'Let me check that.' : 'Your order ships tomorrow.'),
      audioStream: emptyStream(),
      modalities: Promise.resolve(['text']),
    };

    return {
      messageStream: oneItemStream(message),
      functionStream: isFirst
        ? oneItemStream(
            FunctionCall.create({ callId: TOOL_CALL_ID, name: 'lookup_order', args: '{}' }),
          )
        : emptyStream<FunctionCall>(),
      userInitiated: true,
      responseId: `response-${this.generations}`,
    };
  }

  async commitAudio(): Promise<void> {}

  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {}

  async truncate(): Promise<void> {}
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession: FakeRealtimeSession;

  constructor(capabilitiesOverrides: Partial<RealtimeCapabilities> = {}) {
    const capabilities: RealtimeCapabilities = {
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: false,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
      midSessionInstructionsUpdate: true,
      midSessionToolsUpdate: true,
      perResponseToolChoice: false,
      ...capabilitiesOverrides,
    };
    super(capabilities);
    this.activeSession = new FakeRealtimeSession(this);
  }

  get model(): string {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    return this.activeSession;
  }

  async close(): Promise<void> {}
}

function createAgent(): Agent {
  return new Agent({
    instructions: 'test',
    tools: {
      lookup_order: tool({
        description: 'Look up an order',
        execute: async () => 'shipping tomorrow',
      }),
    },
  });
}

async function runToolCall(capabilities: Partial<RealtimeCapabilities>) {
  const llm = new FakeRealtimeModel(capabilities);
  const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
  const agent = createAgent();

  await session.start({ agent });
  try {
    await session.generateReply().waitForPlayout();
    // The tool runs as a background speech, so the outputs land after playout.
    await vi.waitFor(() =>
      expect(agent.chatCtx.items.some((item) => item.type === 'function_call_output')).toBe(true),
    );
  } finally {
    await session.close();
  }

  return { agent, session };
}

describe('Realtime tool output commit', () => {
  // Regression: the realtime path pushed tool outputs only into the copy sent to
  // the provider and into `session.history`, never into `agent._chatCtx`. That
  // left the agent context with a `function_call` and no matching output, so
  // history summarization (which distills tool results) and handoff merges saw a
  // dangling call. Python commits both (agent_activity.py `_upsert_item`).
  it('commits tool outputs to the agent chat context', async () => {
    const { agent } = await runToolCall({ autoToolReplyGeneration: true });

    const calls = agent.chatCtx.items.filter((item) => item.type === 'function_call');
    const outputs = agent.chatCtx.items.filter((item) => item.type === 'function_call_output');

    expect(calls.map((c) => c.callId)).toEqual([TOOL_CALL_ID]);
    expect(outputs.map((o) => o.callId)).toEqual([TOOL_CALL_ID]);
    expect(outputs[0]?.output).toBe(JSON.stringify('shipping tomorrow'));

    // The output must follow its call so summarization renders them in order.
    const items = agent.chatCtx.items;
    expect(items.indexOf(outputs[0]!)).toBeGreaterThan(items.indexOf(calls[0]!));
  });

  it('commits tool outputs to the agent chat context when the model needs an explicit reply', async () => {
    const { agent } = await runToolCall({ autoToolReplyGeneration: false });

    const outputs = agent.chatCtx.items.filter((item) => item.type === 'function_call_output');
    expect(outputs.map((o) => o.callId)).toEqual([TOOL_CALL_ID]);
  });

  it('keeps session history in sync with the agent chat context', async () => {
    const { agent, session } = await runToolCall({ autoToolReplyGeneration: true });

    const toolItemIds = (ctx: { items: readonly ChatItem[] }) =>
      ctx.items
        .filter((item) => item.type === 'function_call' || item.type === 'function_call_output')
        .map((item) => `${item.type}:${item.callId}`);

    expect(toolItemIds(agent.chatCtx)).toEqual(toolItemIds(session.history));
  });
});
