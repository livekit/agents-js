// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { ChatContext, type FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type MessageGeneration,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';

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

  updateOptions(_options: { toolChoice?: ToolChoice | null }): void {}

  pushAudio(_frame: AudioFrame): void {}

  async generateReply(): Promise<GenerationCreatedEvent> {
    const message: MessageGeneration = {
      messageId: 'message-id',
      textStream: oneItemStream('Hello'),
      audioStream: emptyStream(),
      modalities: Promise.resolve(['text']),
    };

    return {
      messageStream: oneItemStream(message),
      functionStream: emptyStream<FunctionCall>(),
      userInitiated: true,
      responseId: 'provider-response-id',
    };
  }

  async commitAudio(): Promise<void> {}

  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {}

  async truncate(): Promise<void> {}
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession: FakeRealtimeSession;

  constructor() {
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

describe('Realtime message metrics', () => {
  it('makes realtime response IDs available on assistant messages', async () => {
    const llm = new FakeRealtimeModel();
    const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
    const conversationEvents: ConversationItemAddedEvent[] = [];

    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      conversationEvents.push(ev);
    });

    await session.start({ agent: new Agent({ instructions: 'test' }) });
    try {
      await session.generateReply().waitForPlayout();
    } finally {
      await session.close();
    }

    const assistantMessages = conversationEvents
      .map((event) => event.item)
      .filter((item) => item.type === 'message' && item.role === 'assistant');

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.metrics.providerRequestIds).toEqual(['provider-response-id']);
  });
});
