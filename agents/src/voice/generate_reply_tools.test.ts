// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext, type FunctionCall } from '../llm/chat_context.js';
import type { LLMStream } from '../llm/llm.js';
import {
  type GenerationCreatedEvent,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import {
  type ToolChoice,
  ToolContext,
  type ToolContextLike,
  ToolFlag,
  Toolset,
  tool,
} from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

const ALL_TOOLS = ['dtmf', 'end_call', 'lookup', 'ts_a', 'ts_b'];

function emptyStream<T>(): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.close();
    },
  });
}

function toolNames(toolCtx: ToolContextLike | undefined): string[] | undefined {
  if (!(toolCtx instanceof ToolContext)) {
    return undefined;
  }
  return toolCtx
    .flatten()
    .map((entry) => entry.id)
    .sort();
}

function createTools(): ToolContext {
  const toolset = new Toolset({
    id: 'ts',
    tools: [
      tool({ name: 'ts_a', description: 'Toolset tool A.', execute: async () => 'a' }),
      tool({ name: 'ts_b', description: 'Toolset tool B.', execute: async () => 'b' }),
    ],
  });
  return new ToolContext([
    toolset,
    tool({ name: 'lookup', description: 'Look up an order.', execute: async () => 'found' }),
    tool({ name: 'dtmf', description: 'Send DTMF digits.', execute: async () => 'sent' }),
    tool({
      name: 'end_call',
      description: 'End the call.',
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async () => 'ended',
    }),
  ]);
}

class ToolsAgent extends Agent {
  constructor() {
    super({ instructions: 'Test per-response tools.', tools: createTools() });
  }
}

class OnEnterAgent extends Agent {
  constructor(private readonly replyTools?: string[]) {
    super({ instructions: 'Test per-response tools in onEnter.', tools: createTools() });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply({ userInput: 'greeting', tools: this.replyTools });
  }
}

class RecordingLLM extends FakeLLM {
  readonly toolSnapshots: (string[] | undefined)[] = [];

  override chat(options: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    this.toolSnapshots.push(toolNames(options.toolCtx));
    return super.chat(options);
  }
}

interface GenerateReplyCall {
  sessionTools: string[] | undefined;
  toolChoice?: ToolChoice;
  tools?: string[];
}

class RecordingRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();
  readonly toolUpdates: (string[] | undefined)[] = [];
  readonly toolChoiceUpdates: (ToolChoice | null | undefined)[] = [];
  readonly generateReplyCalls: GenerateReplyCall[] = [];

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
    this.toolUpdates.push(toolNames(tools));
    this._tools = tools.copy();
  }

  updateOptions(options: { toolChoice?: ToolChoice | null }): void {
    this.toolChoiceUpdates.push(options.toolChoice);
  }

  pushAudio(_frame: AudioFrame): void {}

  async generateReply(
    _instructions?: string,
    options: { signal?: AbortSignal; toolChoice?: ToolChoice; tools?: ToolContext } = {},
  ): Promise<GenerationCreatedEvent> {
    this.generateReplyCalls.push({
      sessionTools: toolNames(this._tools),
      ...(options.toolChoice !== undefined && { toolChoice: options.toolChoice }),
      ...(options.tools !== undefined && { tools: toolNames(options.tools) }),
    });
    return {
      messageStream: emptyStream(),
      functionStream: emptyStream<FunctionCall>(),
      userInitiated: true,
    };
  }

  async commitAudio(): Promise<void> {}

  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {}

  async truncate(): Promise<void> {}
}

class RecordingRealtimeModel extends RealtimeModel {
  readonly recordingSession: RecordingRealtimeSession;

  constructor({ perResponseToolChoice }: { perResponseToolChoice: boolean }) {
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
      perResponseToolChoice,
    };
    super(capabilities);
    this.recordingSession = new RecordingRealtimeSession(this);
  }

  get model(): string {
    return 'recording-realtime';
  }

  session(): RealtimeSession {
    return this.recordingSession;
  }

  async close(): Promise<void> {}
}

describe('AgentSession.generateReply tools', () => {
  it('sends the requested tools and tool choice per response', async () => {
    const llm = new RecordingRealtimeModel({ perResponseToolChoice: true });
    const rtSession = llm.recordingSession;
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new ToolsAgent() });
      const startupToolUpdates = [...rtSession.toolUpdates];

      await session
        .generateReply({
          userInput: 'hello',
          tools: ['dtmf', 'ts', 'dtmf'],
          toolChoice: 'required',
        })
        .waitForPlayout();

      expect(rtSession.generateReplyCalls).toEqual([
        { sessionTools: ALL_TOOLS, toolChoice: 'required', tools: ['dtmf', 'ts_a', 'ts_b'] },
      ]);
      expect(rtSession.toolUpdates).toEqual(startupToolUpdates);
      expect(rtSession.toolChoiceUpdates).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('swaps and restores the session tools and tool choice without per-response support', async () => {
    const llm = new RecordingRealtimeModel({ perResponseToolChoice: false });
    const rtSession = llm.recordingSession;
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new ToolsAgent() });
      const startupToolUpdates = [...rtSession.toolUpdates];

      await session
        .generateReply({ userInput: 'hello', tools: ['lookup'], toolChoice: 'required' })
        .waitForPlayout();

      expect(rtSession.generateReplyCalls).toEqual([{ sessionTools: ['lookup'] }]);
      expect(rtSession.toolUpdates).toEqual([...startupToolUpdates, ['lookup'], ALL_TOOLS]);
      expect(rtSession.toolChoiceUpdates).toEqual(['required', null]);
      expect(toolNames(rtSession.tools)).toEqual(ALL_TOOLS);
    } finally {
      await session.close();
    }
  });

  it('keeps the session tools when no tools are requested', async () => {
    const llm = new RecordingRealtimeModel({ perResponseToolChoice: false });
    const rtSession = llm.recordingSession;
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new ToolsAgent() });
      const startupToolUpdates = [...rtSession.toolUpdates];

      await session.generateReply({ userInput: 'hello' }).waitForPlayout();

      expect(rtSession.generateReplyCalls).toEqual([{ sessionTools: ALL_TOOLS }]);
      expect(rtSession.toolUpdates).toEqual(startupToolUpdates);
      expect(rtSession.toolChoiceUpdates).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('hides IGNORE_ON_ENTER tools per response inside onEnter', async () => {
    const llm = new RecordingRealtimeModel({ perResponseToolChoice: true });
    const rtSession = llm.recordingSession;
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new OnEnterAgent(['end_call', 'dtmf']) });
      await vi.waitFor(() => expect(rtSession.generateReplyCalls).toHaveLength(1));
      await session.generateReply({ userInput: 'later turn' }).waitForPlayout();

      expect(rtSession.generateReplyCalls).toEqual([
        { sessionTools: ALL_TOOLS, tools: ['dtmf'] },
        { sessionTools: ALL_TOOLS },
      ]);
      expect(rtSession.toolUpdates.every((update) => update?.includes('end_call'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('hides IGNORE_ON_ENTER tools per response inside onEnter without requested tools', async () => {
    const llm = new RecordingRealtimeModel({ perResponseToolChoice: true });
    const rtSession = llm.recordingSession;
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new OnEnterAgent() });
      await vi.waitFor(() => expect(rtSession.generateReplyCalls).toHaveLength(1));

      expect(rtSession.generateReplyCalls[0]?.tools).toEqual(['dtmf', 'lookup', 'ts_a', 'ts_b']);
      expect(rtSession.toolUpdates.every((update) => update?.includes('end_call'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('limits the pipeline LLM tools to the requested tools', async () => {
    const llm = new RecordingLLM([{ input: 'hello', content: 'hi' }]);
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new ToolsAgent() });
      await session.generateReply({ userInput: 'hello', tools: ['ts', 'lookup'] }).waitForPlayout();

      expect(llm.toolSnapshots).toEqual([['lookup', 'ts_a', 'ts_b']]);
    } finally {
      await session.close();
    }
  });

  it('throws for a tool ID that is not registered and creates no speech', async () => {
    const llm = new RecordingRealtimeModel({ perResponseToolChoice: true });
    const session = new AgentSession({ llm });
    const speechCreated = vi.fn();
    session.on('speech_created', speechCreated);

    try {
      await session.start({ agent: new ToolsAgent() });
      speechCreated.mockClear();

      expect(() => session.generateReply({ userInput: 'hello', tools: ['missing'] })).toThrow(
        `tool 'missing' not found in agent's registered tools. ` +
          `Available tools: ["ts_a","ts_b","lookup","dtmf","end_call"]`,
      );
      expect(speechCreated).not.toHaveBeenCalled();
      expect(llm.recordingSession.generateReplyCalls).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
