// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import type { Instructions, ReadonlyChatContext } from '../llm/chat_context.js';
import type {
  ChatChunk,
  ChatContext,
  ChatMessage,
  LLM,
  RealtimeModel,
  ToolContext,
} from '../llm/index.js';
import type { STT, SpeechEvent } from '../stt/index.js';
import type { TTS } from '../tts/index.js';
import type { FlushSentinel } from '../types.js';
import { readStream, toStream } from '../utils.js';
import type { VAD } from '../vad.js';
import type { Agent, AgentOptions, AgentTask, AgentTaskOptions, ModelSettings } from './agent.js';
import type { AgentSession } from './agent_session.js';
import type { TurnHandlingOptions } from './turn_config/turn_handling.js';

/** Context passed to hooks created with `Agent.create()`. */
export interface AgentContext<UserData = unknown> {
  /** The agent instance currently running the hook. */
  agent: Agent<UserData>;
  /** Voice activity detector configured for the agent. */
  vad: VAD | undefined;
  /** Speech-to-text model configured for the agent. */
  stt: STT | undefined;
  /** LLM or realtime model configured for the agent. */
  llm: LLM | RealtimeModel | undefined;
  /** Text-to-speech model configured for the agent. */
  tts: TTS | undefined;
  /** Whether TTS-aligned transcripts are enabled for the agent. */
  useTtsAlignedTranscript: boolean | undefined;
  /** Readonly view of the agent's current chat context. */
  chatCtx: ReadonlyChatContext;
  /** Agent identifier. */
  id: string;
  /** Agent instructions. */
  instructions: string | Instructions;
  /** Copy of the agent tool context. */
  toolCtx: ToolContext<UserData>;
  /** Current session for the agent. */
  session: AgentSession<UserData>;
  /** Agent-level turn handling configuration. */
  turnHandling: Partial<TurnHandlingOptions> | undefined;
  /** Minimum delay between consecutive speech. */
  minConsecutiveSpeechDelay: number | undefined;
}

/** Return type for stream hooks. Returning `null` stops that pipeline node. */
export type AgentHookNodeResult<T> = AsyncIterable<T> | Promise<AsyncIterable<T> | null> | null;

export interface AgentHooks<
  UserData,
  ContextT extends AgentContext<UserData> = AgentContext<UserData>,
> {
  /** Called when the agent becomes active in a session. */
  onEnter?: (ctx: ContextT) => Promise<void> | void;
  /** Called when the agent is leaving the active session. */
  onExit?: (ctx: ContextT) => Promise<void> | void;
  /** Called after the user's turn has been committed to the chat context. */
  onUserTurnCompleted?: (
    ctx: ContextT,
    chatCtx: ChatContext,
    newMessage: ChatMessage,
  ) => Promise<void> | void;
  /** Transforms incoming audio into speech events or transcript text for the agent. */
  sttNode?: (
    ctx: ContextT,
    audio: AsyncIterable<AudioFrame>,
    modelSettings: ModelSettings,
  ) => AgentHookNodeResult<SpeechEvent | string>;
  /** Produces LLM chunks or text from the current chat and tool context. */
  llmNode?: (
    ctx: ContextT,
    chatCtx: ChatContext,
    toolCtx: ToolContext<UserData>,
    modelSettings: ModelSettings,
  ) => AgentHookNodeResult<ChatChunk | string>;
  /** Synthesizes agent text into audio frames for playout. */
  ttsNode?: (
    ctx: ContextT,
    text: AsyncIterable<string>,
    modelSettings: ModelSettings,
  ) => AgentHookNodeResult<AudioFrame>;
  /** Processes realtime model audio before it is sent to the agent output. */
  realtimeAudioOutputNode?: (
    ctx: ContextT,
    audio: AsyncIterable<AudioFrame>,
    modelSettings: ModelSettings,
  ) => AgentHookNodeResult<AudioFrame>;
}

export interface AgentCreateOptions<UserData = any>
  extends AgentOptions<UserData>,
    AgentHooks<UserData> {}

/** Context passed to hooks created with `AgentTask.create()`. */
export interface AgentTaskContext<ResultT = unknown, UserData = unknown>
  extends AgentContext<UserData> {
  /** The task instance currently running the hook. */
  agent: AgentTask<ResultT, UserData>;
  /** Complete the task with either a result or an error. */
  complete(result: ResultT | Error): void;
}

export interface AgentTaskCreateOptions<ResultT = unknown, UserData = any>
  extends AgentTaskOptions<UserData>,
    AgentHooks<UserData, AgentTaskContext<ResultT, UserData>> {}

// agent.ts passes these runtime base classes in to avoid a circular runtime import.
type AgentCtor<UserData> = new (options: AgentOptions<UserData>) => Agent<UserData>;

type AgentTaskCtor<ResultT, UserData> = new (
  options: AgentTaskOptions<UserData>,
) => AgentTask<ResultT, UserData>;

export function createAgentV2<UserData>(
  AgentBase: AgentCtor<UserData>,
  options: AgentCreateOptions<UserData>,
): Agent<UserData> {
  class AgentV2 extends AgentBase {
    private readonly hookAdapter: AgentHookAdapter<UserData, AgentContext<UserData>>;

    constructor({
      onEnter,
      onExit,
      onUserTurnCompleted,
      sttNode,
      llmNode,
      ttsNode,
      realtimeAudioOutputNode,
      ...agentOptions
    }: AgentCreateOptions<UserData>) {
      super({
        ...agentOptions,
        id: agentOptions.id ?? 'default_agent',
      });

      this.hookAdapter = new AgentHookAdapter(
        {
          onEnter,
          onExit,
          onUserTurnCompleted,
          sttNode,
          llmNode,
          ttsNode,
          realtimeAudioOutputNode,
        },
        new AgentHookContext(this),
      );
    }

    override async onEnter(): Promise<void> {
      return this.hookAdapter.onEnter(() => super.onEnter());
    }

    override async onExit(): Promise<void> {
      return this.hookAdapter.onExit(() => super.onExit());
    }

    override async onUserTurnCompleted(
      chatCtx: ChatContext,
      newMessage: ChatMessage,
    ): Promise<void> {
      return this.hookAdapter.onUserTurnCompleted(chatCtx, newMessage, () =>
        super.onUserTurnCompleted(chatCtx, newMessage),
      );
    }

    override async sttNode(
      audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<SpeechEvent | string> | null> {
      return this.hookAdapter.sttNode(audio, modelSettings, () =>
        super.sttNode(audio, modelSettings),
      );
    }

    override async llmNode(
      chatCtx: ChatContext,
      toolCtx: ToolContext,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<ChatChunk | string | FlushSentinel> | null> {
      return this.hookAdapter.llmNode(chatCtx, toolCtx, modelSettings, () =>
        super.llmNode(chatCtx, toolCtx, modelSettings),
      );
    }

    override async ttsNode(
      text: ReadableStream<string> | AsyncIterable<string>,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<AudioFrame> | null> {
      return this.hookAdapter.ttsNode(text, modelSettings, () =>
        super.ttsNode(text, modelSettings),
      );
    }

    override async realtimeAudioOutputNode(
      audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<AudioFrame> | null> {
      return this.hookAdapter.realtimeAudioOutputNode(audio, modelSettings, () =>
        super.realtimeAudioOutputNode(audio, modelSettings),
      );
    }
  }

  return new AgentV2(options);
}

export function createAgentTaskV2<ResultT, UserData>(
  AgentTaskBase: AgentTaskCtor<ResultT, UserData>,
  options: AgentTaskCreateOptions<ResultT, UserData>,
): AgentTask<ResultT, UserData> {
  class AgentTaskV2 extends AgentTaskBase {
    private readonly hookAdapter: AgentHookAdapter<UserData, AgentTaskContext<ResultT, UserData>>;

    constructor({
      onEnter,
      onExit,
      onUserTurnCompleted,
      sttNode,
      llmNode,
      ttsNode,
      realtimeAudioOutputNode,
      ...taskOptions
    }: AgentTaskCreateOptions<ResultT, UserData>) {
      super({
        ...taskOptions,
        id: taskOptions.id ?? 'default_agent',
      });

      this.hookAdapter = new AgentHookAdapter(
        {
          onEnter,
          onExit,
          onUserTurnCompleted,
          sttNode,
          llmNode,
          ttsNode,
          realtimeAudioOutputNode,
        },
        new AgentTaskHookContext(this),
      );
    }

    override async onEnter(): Promise<void> {
      return this.hookAdapter.onEnter(() => super.onEnter());
    }

    override async onExit(): Promise<void> {
      return this.hookAdapter.onExit(() => super.onExit());
    }

    override async onUserTurnCompleted(
      chatCtx: ChatContext,
      newMessage: ChatMessage,
    ): Promise<void> {
      return this.hookAdapter.onUserTurnCompleted(chatCtx, newMessage, () =>
        super.onUserTurnCompleted(chatCtx, newMessage),
      );
    }

    override async sttNode(
      audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<SpeechEvent | string> | null> {
      return this.hookAdapter.sttNode(audio, modelSettings, () =>
        super.sttNode(audio, modelSettings),
      );
    }

    override async llmNode(
      chatCtx: ChatContext,
      toolCtx: ToolContext,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<ChatChunk | string | FlushSentinel> | null> {
      return this.hookAdapter.llmNode(chatCtx, toolCtx, modelSettings, () =>
        super.llmNode(chatCtx, toolCtx, modelSettings),
      );
    }

    override async ttsNode(
      text: ReadableStream<string> | AsyncIterable<string>,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<AudioFrame> | null> {
      return this.hookAdapter.ttsNode(text, modelSettings, () =>
        super.ttsNode(text, modelSettings),
      );
    }

    override async realtimeAudioOutputNode(
      audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<AudioFrame> | null> {
      return this.hookAdapter.realtimeAudioOutputNode(audio, modelSettings, () =>
        super.realtimeAudioOutputNode(audio, modelSettings),
      );
    }
  }

  return new AgentTaskV2(options);
}

class AgentHookAdapter<UserData, ContextT extends AgentContext<UserData>> {
  constructor(
    private readonly hooks: AgentHooks<UserData, ContextT>,
    private readonly context: ContextT,
  ) {}

  async onEnter(fallback: () => Promise<void>): Promise<void> {
    if (!this.hooks.onEnter) {
      return fallback();
    }

    return this.hooks.onEnter(this.context);
  }

  async onExit(fallback: () => Promise<void>): Promise<void> {
    if (!this.hooks.onExit) {
      return fallback();
    }

    return this.hooks.onExit(this.context);
  }

  async onUserTurnCompleted(
    chatCtx: ChatContext,
    newMessage: ChatMessage,
    fallback: () => Promise<void>,
  ): Promise<void> {
    if (!this.hooks.onUserTurnCompleted) {
      return fallback();
    }

    return this.hooks.onUserTurnCompleted(this.context, chatCtx, newMessage);
  }

  async sttNode(
    audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
    modelSettings: ModelSettings,
    fallback: () => Promise<ReadableStream<SpeechEvent | string> | null>,
  ): Promise<ReadableStream<SpeechEvent | string> | null> {
    if (!this.hooks.sttNode) {
      return fallback();
    }

    const input = audio instanceof ReadableStream ? readStream(audio) : audio;
    const result = await this.hooks.sttNode(this.context, input, modelSettings);
    return result === null ? null : toStream(result);
  }

  async llmNode(
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
    fallback: () => Promise<ReadableStream<ChatChunk | string | FlushSentinel> | null>,
  ): Promise<ReadableStream<ChatChunk | string | FlushSentinel> | null> {
    if (!this.hooks.llmNode) {
      return fallback();
    }

    const result = await this.hooks.llmNode(
      this.context,
      chatCtx,
      toolCtx as ToolContext<UserData>,
      modelSettings,
    );
    return result === null ? null : toStream(result);
  }

  async ttsNode(
    text: ReadableStream<string> | AsyncIterable<string>,
    modelSettings: ModelSettings,
    fallback: () => Promise<ReadableStream<AudioFrame> | null>,
  ): Promise<ReadableStream<AudioFrame> | null> {
    if (!this.hooks.ttsNode) {
      return fallback();
    }

    const input = text instanceof ReadableStream ? readStream(text) : text;
    const result = await this.hooks.ttsNode(this.context, input, modelSettings);
    return result === null ? null : toStream(result);
  }

  async realtimeAudioOutputNode(
    audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
    modelSettings: ModelSettings,
    fallback: () => Promise<ReadableStream<AudioFrame> | null>,
  ): Promise<ReadableStream<AudioFrame> | null> {
    if (!this.hooks.realtimeAudioOutputNode) {
      return fallback();
    }

    const input = audio instanceof ReadableStream ? readStream(audio) : audio;
    const result = await this.hooks.realtimeAudioOutputNode(this.context, input, modelSettings);
    return result === null ? null : toStream(result);
  }
}

class AgentHookContext<UserData> implements AgentContext<UserData> {
  constructor(readonly agent: Agent<UserData>) {}

  get vad(): VAD | undefined {
    return this.agent.vad;
  }

  get stt(): STT | undefined {
    return this.agent.stt;
  }

  get llm(): LLM | RealtimeModel | undefined {
    return this.agent.llm;
  }

  get tts(): TTS | undefined {
    return this.agent.tts;
  }

  get useTtsAlignedTranscript(): boolean | undefined {
    return this.agent.useTtsAlignedTranscript;
  }

  get chatCtx(): ReadonlyChatContext {
    return this.agent.chatCtx;
  }

  get id(): string {
    return this.agent.id;
  }

  get instructions(): string | Instructions {
    return this.agent.instructions;
  }

  get toolCtx(): ToolContext<UserData> {
    return this.agent.toolCtx;
  }

  get session(): AgentSession<UserData> {
    return this.agent.session;
  }

  get turnHandling(): Partial<TurnHandlingOptions> | undefined {
    return this.agent.turnHandling;
  }

  get minConsecutiveSpeechDelay(): number | undefined {
    return this.agent.minConsecutiveSpeechDelay;
  }
}

class AgentTaskHookContext<ResultT, UserData>
  extends AgentHookContext<UserData>
  implements AgentTaskContext<ResultT, UserData>
{
  declare readonly agent: AgentTask<ResultT, UserData>;

  constructor(agent: AgentTask<ResultT, UserData>) {
    super(agent);
  }

  complete(result: ResultT | Error): void {
    this.agent.complete(result);
  }
}
