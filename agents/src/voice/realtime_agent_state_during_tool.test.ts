// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type MessageGeneration,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, type ToolContext, tool } from '../llm/tool_context.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';

function streamOf<T>(...values: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

function generation(text: string, functionCalls: FunctionCall[] = []): GenerationCreatedEvent {
  const message: MessageGeneration = {
    messageId: `message-${Math.random()}`,
    textStream: streamOf(text),
    audioStream: streamOf(),
    modalities: Promise.resolve(['text']),
  };
  return {
    messageStream: streamOf(message),
    functionStream: streamOf(...functionCalls),
    userInitiated: true,
  };
}

class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx: ChatContext;
  private _tools: ToolContext;
  readonly replyResolvers: Array<(event: GenerationCreatedEvent) => void> = [];

  constructor(model: RealtimeModel, chatCtx: ChatContext, tools: ToolContext) {
    super(model);
    this._chatCtx = chatCtx;
    this._tools = tools;
  }

  get chatCtx(): ChatContext {
    return this._chatCtx;
  }

  get tools(): ToolContext {
    return this._tools;
  }

  async updateInstructions(): Promise<void> {}
  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    this._chatCtx = chatCtx;
  }
  async updateTools(tools: ToolContext): Promise<void> {
    this._tools = tools;
  }
  updateOptions(_options: { toolChoice?: ToolChoice | null }): void {}
  pushAudio(): void {}
  generateReply(): Promise<GenerationCreatedEvent> {
    return new Promise((resolve) => this.replyResolvers.push(resolve));
  }
  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async truncate(): Promise<void> {}
}

class FakeRealtimeModel extends RealtimeModel {
  activeSession?: FakeRealtimeSession;

  constructor() {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: true,
      audioOutput: false,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
      midSessionInstructionsUpdate: true,
      midSessionToolsUpdate: true,
    });
  }

  get model(): string {
    return 'fake-realtime';
  }

  session(options?: { chatCtx?: ChatContext; tools?: ToolContext }): RealtimeSession {
    this.activeSession = new FakeRealtimeSession(
      this,
      options?.chatCtx ?? ChatContext.empty(),
      options?.tools ?? {},
    );
    return this.activeSession;
  }

  async close(): Promise<void> {}
}

async function nextReply(
  model: FakeRealtimeModel,
): Promise<(event: GenerationCreatedEvent) => void> {
  await vi.waitFor(() => expect(model.activeSession?.replyResolvers.length).toBeGreaterThan(0));
  return model.activeSession!.replyResolvers.shift()!;
}

describe('realtime agent state during tool execution', () => {
  const sessions: AgentSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it('realtime say during tool keeps agent thinking', async () => {
    const model = new FakeRealtimeModel();
    let releaseTool!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let markToolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const session = new AgentSession({ llm: model, userAwayTimeout: 0.2 });
    sessions.push(session);
    const userStates: string[] = [];
    session.on('user_state_changed', (event) => userStates.push(event.newState));
    await session.start({
      agent: new Agent({
        instructions: 'test',
        tools: {
          lookupOrder: tool({
            description: 'look up an order',
            execute: async () => {
              markToolStarted();
              await toolStarted;
              return 'order 42 shipped';
            },
          }),
        },
      }),
    });

    const reply = session.generateReply();
    const resolveReply = await nextReply(model);
    resolveReply(
      generation('let me check', [
        FunctionCall.create({ callId: 'call-1', name: 'lookupOrder', args: '{}' }),
      ]),
    );
    await started;
    await vi.waitFor(() => expect(session.agentState).toBe('thinking'));

    await session.say('just a moment').waitForPlayout();
    expect(session.agentState).toBe('thinking');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(userStates).not.toContain('away');

    releaseTool();
    await reply.waitForPlayout();
  });

  it('realtime tool without a reply returns the agent to listening', async () => {
    const model = new FakeRealtimeModel();
    const session = new AgentSession({ llm: model });
    sessions.push(session);
    await session.start({
      agent: new Agent({
        instructions: 'test',
        tools: {
          silentLookup: tool({ description: 'silent lookup', execute: async () => undefined }),
        },
      }),
    });

    const reply = session.generateReply();
    const resolveReply = await nextReply(model);
    resolveReply(
      generation('let me check', [
        FunctionCall.create({ callId: 'call-2', name: 'silentLookup', args: '{}' }),
      ]),
    );
    await reply.waitForPlayout();
    await vi.waitFor(() => expect(session.agentState).toBe('listening'));
  });

  it('realtime tool reply from the server keeps the agent thinking', async () => {
    const model = new FakeRealtimeModel();
    const session = new AgentSession({ llm: model, userAwayTimeout: 0.2 });
    sessions.push(session);
    const userStates: string[] = [];
    session.on('user_state_changed', (event) => userStates.push(event.newState));
    await session.start({
      agent: new Agent({
        instructions: 'test',
        tools: {
          lookupOrder: tool({
            description: 'look up an order',
            execute: async () => 'order 42 shipped',
          }),
        },
      }),
    });

    const reply = session.generateReply();
    const resolveReply = await nextReply(model);
    resolveReply(
      generation('let me check', [
        FunctionCall.create({ callId: 'call-3', name: 'lookupOrder', args: '{}' }),
      ]),
    );
    await reply.waitForPlayout();

    expect(session.agentState).toBe('thinking');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(session.agentState).toBe('thinking');
    expect(userStates).not.toContain('away');
  });
});
