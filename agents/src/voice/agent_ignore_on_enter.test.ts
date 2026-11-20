// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
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
import type { FakeRecognizeStream } from '../stt/testing/fake_stt.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import type { APIConnectOptions } from '../types.js';
import { Agent, AgentTask, StopResponse } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioInput } from './io.js';
import type { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

const EXPECTED_GREETING_TOOLS = ['allowed_nested', 'allowed_plain'];
const EXPECTED_USER_TURN_TOOLS = [
  'allowed_nested',
  'allowed_plain',
  'ignored_nested',
  'ignored_plain',
];

class ScriptedAudioInput extends AudioInput {
  #controller!: ReadableStreamDefaultController<AudioFrame>;

  constructor() {
    super();
    this.multiStream.addInputStream(
      new ReadableStream<AudioFrame>({
        start: (controller) => {
          this.#controller = controller;
        },
      }),
    );
  }

  push(): void {
    const samples = 320;
    this.#controller.enqueue(new AudioFrame(new Int16Array(samples), 16_000, 1, samples));
  }
}

function recordSttStreams(stt: FakeSTT): FakeRecognizeStream[] {
  const streams: FakeRecognizeStream[] = [];
  void (async () => {
    for await (const stream of stt.streamCh) {
      streams.push(stream);
    }
  })();
  return streams;
}

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

function toolNames(toolCtx: ToolContextLike | undefined): string[] {
  if (!(toolCtx instanceof ToolContext)) {
    return [];
  }
  return toolCtx
    .flatten()
    .map((entry) => entry.id)
    .sort();
}

function createTools(): ToolContext {
  const allowedNested = tool({
    name: 'allowed_nested',
    description: 'Allowed nested probe.',
    execute: async () => 'nested allowed result',
  });
  const ignoredNested = tool({
    name: 'ignored_nested',
    description: 'Ignored nested probe.',
    flags: ToolFlag.IGNORE_ON_ENTER,
    execute: async () => 'nested ignored result',
  });
  const inner = new Toolset({
    id: 'inner',
    tools: [allowedNested, ignoredNested],
  });
  const outer = new Toolset({
    id: 'outer',
    tools: [inner],
  });
  const allowedPlain = tool({
    name: 'allowed_plain',
    description: 'Allowed plain probe.',
    execute: async () => 'plain allowed result',
  });
  const ignoredPlain = tool({
    name: 'ignored_plain',
    description: 'Ignored plain probe.',
    flags: ToolFlag.IGNORE_ON_ENTER,
    execute: async () => 'plain ignored result',
  });
  return new ToolContext([outer, allowedPlain, ignoredPlain]);
}

class ImmediateTask extends AgentTask<void> {
  constructor() {
    super({ instructions: 'Complete setup.' });
  }

  async onEnter(): Promise<void> {
    this.complete(undefined);
  }
}

class GreetingAgent extends Agent {
  constructor(private readonly withTask = false) {
    super({
      instructions: 'Test tool visibility.',
      tools: createTools(),
    });
  }

  async onEnter(): Promise<void> {
    if (this.withTask) {
      await new ImmediateTask().run();
    }
    this.session.generateReply({ userInput: 'greeting' });
  }
}

class CleanupFailureAgent extends Agent {
  speech?: SpeechHandle;

  constructor() {
    super({
      instructions: 'Test cleanup failure isolation.',
      tools: createTools(),
    });
  }

  async onEnter(): Promise<void> {
    this.speech = this.session.generateReply({
      userInput: 'greeting',
      toolChoice: 'none',
    });
  }
}

class RecordingLLM extends FakeLLM {
  readonly toolSnapshots: string[][] = [];

  override chat({
    chatCtx,
    toolCtx,
    connOptions,
    parallelToolCalls,
    toolChoice,
    extraKwargs,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    this.toolSnapshots.push(toolNames(toolCtx));
    return super.chat({
      chatCtx,
      toolCtx,
      connOptions,
      parallelToolCalls,
      toolChoice,
      extraKwargs,
    });
  }
}

type RealtimeFailureOptions = {
  rejectFilteredUpdate?: boolean;
  generationError?: Error;
  emptyGeneration?: boolean;
  throwToolChoiceRestore?: boolean;
  throwToolRestore?: 'before' | 'after';
};

class RecordingRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();
  private readonly failureOptions: RealtimeFailureOptions;
  private temporaryToolsApplied = false;
  readonly toolSnapshots: string[][] = [];
  rejectedTemporaryUpdates = 0;
  toolChoiceRestorationAttempts = 0;
  toolRestorationAttempts = 0;

  constructor(model: RealtimeModel, failureOptions: RealtimeFailureOptions = {}) {
    super(model);
    this.failureOptions = failureOptions;
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
    const isFilteredUpdate = !toolNames(tools).includes('ignored_nested');
    const isRestoration = this.temporaryToolsApplied && !isFilteredUpdate;
    if (isRestoration) {
      this.toolRestorationAttempts++;
      if (this.failureOptions.throwToolRestore === 'before') {
        throw new Error('tool restoration failure');
      }
    }

    this._tools = tools.copy();
    this.temporaryToolsApplied = isFilteredUpdate;

    if (isRestoration && this.failureOptions.throwToolRestore === 'after') {
      throw new Error('tool restoration failure after apply');
    }
    if (
      this.failureOptions.rejectFilteredUpdate &&
      this.rejectedTemporaryUpdates === 0 &&
      isFilteredUpdate
    ) {
      this.rejectedTemporaryUpdates++;
      throw new Error('temporary realtime tools rejected after mutation');
    }
  }

  updateOptions(options: { toolChoice?: ToolChoice | null }): void {
    if (options.toolChoice !== 'none' && this.failureOptions.throwToolChoiceRestore) {
      this.toolChoiceRestorationAttempts++;
      throw new Error('tool-choice restoration failure');
    }
  }

  pushAudio(_frame: AudioFrame): void {}

  async generateReply(): Promise<GenerationCreatedEvent> {
    this.toolSnapshots.push(toolNames(this._tools));
    if (this.failureOptions.generationError) {
      throw this.failureOptions.generationError;
    }
    const functionStream =
      !this.failureOptions.emptyGeneration && this.toolSnapshots.length === 1
        ? oneItemStream(
            FunctionCall.create({
              callId: 'allowed-call',
              name: 'allowed_nested',
              args: '{}',
            }),
          )
        : emptyStream<FunctionCall>();
    return {
      messageStream: emptyStream(),
      functionStream,
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

  constructor(failureOptions: RealtimeFailureOptions = {}) {
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
    this.recordingSession = new RecordingRealtimeSession(this, failureOptions);
  }

  get model(): string {
    return 'recording-realtime';
  }

  session(): RealtimeSession {
    return this.recordingSession;
  }

  async close(): Promise<void> {}
}

describe('AgentSession IGNORE_ON_ENTER tool filtering', () => {
  it.each([false, true])(
    'filters nested tools from pipeline greeting and tool response, then restores them (with task: %s)',
    async (withTask) => {
      const stt = new FakeSTT();
      const sttStreams = recordSttStreams(stt);
      const llm = new RecordingLLM([
        {
          input: 'greeting',
          toolCalls: [{ name: 'allowed_nested', args: {} }],
        },
        {
          input: 'nested allowed result',
          content: 'hello',
        },
        {
          input: 'later user turn',
          content: 'welcome back',
        },
      ]);
      const session = new AgentSession({ llm, stt });
      const audioInput = new ScriptedAudioInput();
      session.input.audio = audioInput;
      const pump = setInterval(() => audioInput.push(), 20);

      try {
        await session.start({ agent: new GreetingAgent(withTask) });
        await vi.waitFor(() => expect(llm.toolSnapshots).toHaveLength(2));
        await vi.waitFor(() => expect(sttStreams).toHaveLength(1));
        sttStreams[0]!.sendFakeTranscript('later user turn');
        await vi.waitFor(() => expect(llm.toolSnapshots).toHaveLength(3));

        expect(llm.toolSnapshots).toEqual([
          EXPECTED_GREETING_TOOLS,
          EXPECTED_GREETING_TOOLS,
          EXPECTED_USER_TURN_TOOLS,
        ]);
      } finally {
        clearInterval(pump);
        await session.close();
      }
    },
  );

  it('does not carry the onEnter marker through a handoff back to the same agent', async () => {
    const endCall = tool({
      name: 'end_call',
      description: 'Ends the call.',
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async () => undefined,
    });
    const keep = tool({
      name: 'keep',
      description: 'A normal tool.',
      execute: async () => undefined,
    });

    class Router extends Agent {
      entered = 0;

      constructor() {
        super({ instructions: 'Route the caller.', tools: [endCall, keep] });
      }

      async onEnter(): Promise<void> {
        this.entered++;
        if (this.entered === 1) {
          await this.session.generateReply({ userInput: 'greet the user' }).waitForPlayout();
          this.session.updateAgent(specialist);
        }
      }
    }

    class Specialist extends Agent {
      constructor() {
        super({ instructions: 'You are a specialist.' });
      }

      async onUserTurnCompleted(): Promise<void> {
        this.session.updateAgent(router);
        throw new StopResponse();
      }
    }

    const router = new Router();
    const specialist = new Specialist();
    const stt = new FakeSTT();
    const sttStreams = recordSttStreams(stt);
    const llm = new RecordingLLM([
      { input: 'greet the user', content: 'Hello!' },
      { input: 'goodbye', content: 'Bye!' },
    ]);
    const session = new AgentSession({
      llm,
      stt,
      turnHandling: { preemptiveGeneration: { enabled: false } },
    });
    const audioInput = new ScriptedAudioInput();
    session.input.audio = audioInput;
    const pump = setInterval(() => audioInput.push(), 20);

    try {
      await session.start({ agent: router });
      await vi.waitFor(() => expect(session.currentAgent).toBe(specialist));
      await vi.waitFor(() => expect(sttStreams).toHaveLength(1));

      sttStreams[0]!.sendFakeTranscript('take me back');
      await vi.waitFor(() => expect(session.currentAgent).toBe(router));
      await vi.waitFor(() => expect(router.entered).toBe(2));
      sttStreams[0]!.sendFakeTranscript('goodbye');
      await vi.waitFor(() => expect(llm.toolSnapshots).toHaveLength(2));

      expect(router.entered).toBe(2);
      expect(llm.toolSnapshots).toEqual([['keep'], ['end_call', 'keep']]);
    } finally {
      clearInterval(pump);
      await session.close();
    }
  });

  it('filters nested tools from realtime greeting and tool response, then restores them', async () => {
    const llm = new RecordingRealtimeModel();
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new GreetingAgent() });
      await vi.waitFor(() => expect(llm.recordingSession.toolSnapshots).toHaveLength(2));
      await session.run({ userInput: 'later user turn' }).wait();

      expect(llm.recordingSession.toolSnapshots).toEqual([
        EXPECTED_GREETING_TOOLS,
        EXPECTED_GREETING_TOOLS,
        EXPECTED_USER_TURN_TOOLS,
      ]);
    } finally {
      await session.close();
    }
  });

  it('restores realtime tools when the temporary provider update mutates then rejects', async () => {
    const llm = new RecordingRealtimeModel({ rejectFilteredUpdate: true });
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new GreetingAgent() });
      await vi.waitFor(() => expect(llm.recordingSession.rejectedTemporaryUpdates).toBe(1));

      expect(toolNames(llm.recordingSession.tools)).toEqual(EXPECTED_USER_TURN_TOOLS);
      const restoredOuter = llm.recordingSession.tools.tools[0];
      expect(restoredOuter).toBeInstanceOf(Toolset);
      if (!(restoredOuter instanceof Toolset)) {
        throw new Error('expected restored outer toolset');
      }
      expect(restoredOuter.id).toBe('outer');
      const restoredInner = restoredOuter.tools[0];
      expect(restoredInner).toBeInstanceOf(Toolset);
      if (!(restoredInner instanceof Toolset)) {
        throw new Error('expected restored inner toolset');
      }
      expect(restoredInner.id).toBe('inner');

      await session.run({ userInput: 'later user turn' }).wait();
      expect(llm.recordingSession.toolSnapshots).toEqual([
        EXPECTED_USER_TURN_TOOLS,
        EXPECTED_USER_TURN_TOOLS,
      ]);
    } finally {
      await session.close();
    }
  });

  it('restores tools and preserves the primary failure when tool-choice cleanup throws', async () => {
    const primaryError = new Error('primary generation failure');
    const llm = new RecordingRealtimeModel({
      generationError: primaryError,
      throwToolChoiceRestore: true,
    });
    const agent = new CleanupFailureAgent();
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent });
      await vi.waitFor(() => expect(agent.speech?._tasks).toHaveLength(1));
      const speechTask = agent.speech?._tasks[0];
      if (!speechTask) {
        throw new Error('expected greeting speech task');
      }
      await expect(speechTask.result).rejects.toBe(primaryError);
      expect(llm.recordingSession.toolChoiceRestorationAttempts).toBe(1);
      expect(llm.recordingSession.toolRestorationAttempts).toBe(1);
      expect(toolNames(llm.recordingSession.tools)).toEqual(EXPECTED_USER_TURN_TOOLS);
    } finally {
      await session.close();
    }
  });

  it('preserves the primary failure when tool restoration throws', async () => {
    const primaryError = new Error('primary generation failure');
    const llm = new RecordingRealtimeModel({
      generationError: primaryError,
      throwToolRestore: 'before',
    });
    const agent = new CleanupFailureAgent();
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent });
      await vi.waitFor(() => expect(agent.speech?._tasks).toHaveLength(1));
      const speechTask = agent.speech?._tasks[0];
      if (!speechTask) {
        throw new Error('expected greeting speech task');
      }
      await expect(speechTask.result).rejects.toBe(primaryError);
      expect(llm.recordingSession.toolRestorationAttempts).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('contains successful-path cleanup failures and restores tools when possible', async () => {
    const llm = new RecordingRealtimeModel({
      emptyGeneration: true,
      throwToolChoiceRestore: true,
      throwToolRestore: 'after',
    });
    const agent = new CleanupFailureAgent();
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent });
      await vi.waitFor(() => expect(agent.speech?._tasks).toHaveLength(1));
      const speechTask = agent.speech?._tasks[0];
      if (!speechTask) {
        throw new Error('expected greeting speech task');
      }
      await expect(speechTask.result).resolves.toBeUndefined();
      expect(llm.recordingSession.toolChoiceRestorationAttempts).toBe(1);
      expect(llm.recordingSession.toolRestorationAttempts).toBe(1);
      expect(toolNames(llm.recordingSession.tools)).toEqual(EXPECTED_USER_TURN_TOOLS);
    } finally {
      await session.close();
    }
  });
});
