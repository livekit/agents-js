// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { ChatContext, ChatMessage, type FunctionCall } from '../llm/chat_context.js';
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
import { AgentSessionEventTypes } from './events.js';

initializeLogger({ pretty: false, level: 'silent' });

function stream<T>(...items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();
  private generation = 0;

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
    const generation = this.generation++;
    const message: MessageGeneration = {
      messageId: `message-${generation}`,
      textStream: stream('Hi'),
      audioStream: stream<AudioFrame>(),
      modalities: Promise.resolve(['text']),
    };
    return {
      messageStream: stream(message),
      functionStream: stream<FunctionCall>(),
      userInitiated: true,
      responseId: `response-${generation}`,
    };
  }

  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async truncate(): Promise<void> {}
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession = new FakeRealtimeSession(this);

  constructor() {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: false,
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

async function withRealtimeTurns<T>(
  fn: (fixture: {
    session: AgentSession;
    model: FakeRealtimeModel;
    agent: Agent;
    added: ChatMessage[];
  }) => Promise<T>,
): Promise<T> {
  const model = new FakeRealtimeModel();
  const session = new AgentSession({
    llm: model,
    vad: null,
    turnHandling: { turnDetection: null },
  });
  const added: ChatMessage[] = [];
  session.on(AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item instanceof ChatMessage && item.role === 'user') added.push(item);
  });
  const agent = new Agent({ instructions: 'test' });
  await session.start({ agent });
  try {
    return await fn({ session, model, agent, added });
  } finally {
    await session.close();
  }
}

async function send(session: AgentSession, userInput: string | ChatMessage): Promise<void> {
  const reply = session.generateReply({ userInput });
  await reply.waitForPlayout();
  expect(reply.exception()).toBeUndefined();
}

async function addedUserMessage(
  userInput: string | ChatMessage,
): Promise<{ added: ChatMessage; realtimeSession: FakeRealtimeSession; agent: Agent }> {
  return withRealtimeTurns(async ({ session, model, agent, added }) => {
    await send(session, userInput);
    expect(added).toHaveLength(1);
    return { added: added[0]!, realtimeSession: model.activeSession, agent };
  });
}

function comparableMessage(message: ChatMessage): Record<string, unknown> {
  const json = message.toJSON() as Record<string, unknown>;
  const { id: _id, extra: _extra, createdAt: _createdAt, ...comparable } = json;
  return comparable;
}

describe('realtime generateReply turns', () => {
  it("keeps the ChatMessage's extra", async () => {
    const sent = ChatMessage.create({
      role: 'user',
      content: 'hello',
      extra: { flag: 'from-app' },
    });

    const { added, realtimeSession, agent } = await addedUserMessage(sent);

    expect(added.extra).toEqual({ flag: 'from-app' });
    expect(added.content).toEqual(['hello']);
    expect(agent.chatCtx.getById(added.id)).toMatchObject({ extra: { flag: 'from-app' } });
    expect(realtimeSession.chatCtx.getById(added.id)).toBeDefined();
  });

  it('leaves text input unchanged', async () => {
    const { added, realtimeSession } = await addedUserMessage('hello');

    expect(added.content).toEqual(['hello']);
    expect(added.extra).toEqual({});
    expect(realtimeSession.chatCtx.getById(added.id)).toBeDefined();
  });

  it('differs from a text turn only by extra', async () => {
    const sent = ChatMessage.create({
      role: 'assistant',
      content: ['first', 'second'],
      interrupted: true,
      transcriptConfidence: 0.4,
      metrics: { endOfTurnDelay: 1.5 },
      extra: { flag: 'from-app' },
    });
    const { added: textTurn } = await addedUserMessage(sent.rawTextContent ?? '');

    const { added, realtimeSession } = await addedUserMessage(sent);

    expect(comparableMessage(added)).toEqual(comparableMessage(textTurn));
    const remote = realtimeSession.chatCtx.getById(added.id);
    expect(remote).toBeInstanceOf(ChatMessage);
    expect(comparableMessage(remote as ChatMessage)).toEqual(comparableMessage(textTurn));
    expect(added.id).not.toBe(sent.id);
    expect(added.extra).toEqual({ flag: 'from-app' });
  });

  it('uses the message as it was when called', async () => {
    const sent = ChatMessage.create({
      role: 'user',
      content: 'hello',
      extra: { flag: 'first' },
    });

    await withRealtimeTurns(async ({ session, added }) => {
      const reply = session.generateReply({ userInput: sent });
      sent.content[0] = 'edited';
      sent.extra.flag = 'edited';
      await reply.waitForPlayout();

      expect(reply.exception()).toBeUndefined();
      expect(added.map(({ content, extra }) => ({ content, extra }))).toEqual([
        { content: ['hello'], extra: { flag: 'first' } },
      ]);
    });
  });

  it("keeps the first turn's tag when a message is retagged and resent", async () => {
    const sent = ChatMessage.create({
      role: 'user',
      content: 'hello',
      extra: { source: 'web' },
    });

    await withRealtimeTurns(async ({ session, added }) => {
      await send(session, sent);
      sent.extra.source = 'sms';
      await send(session, sent);

      expect(added.map((message) => message.extra)).toEqual([{ source: 'web' }, { source: 'sms' }]);
      expect(added[0]!.id).not.toBe(added[1]!.id);
      expect(session.history.getById(added[0]!.id)).toMatchObject({ extra: { source: 'web' } });
    });
  });
});
