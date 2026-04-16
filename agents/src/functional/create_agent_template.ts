// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import type { ReadonlyChatContext } from '../llm/chat_context.js';
import type { ChatContext, ChatMessage, LLM, RealtimeModel } from '../llm/index.js';
import { type ChatChunk, type ToolContext, isFunctionTool, tool } from '../llm/index.js';
import type { JSONObject, ToolExecuteFunction, ToolInputSchema } from '../llm/tool_context.js';
import type { STT, SpeechEvent } from '../stt/index.js';
import type { TTS } from '../tts/index.js';
import { asyncIterableToReadableStream, readableStreamToAsyncIterable } from '../utils.js';
import type { VAD } from '../vad.js';
import { Agent, type AgentOptions, type ModelSettings } from '../voice/agent.js';
import type { AgentSession } from '../voice/agent_session.js';
import type { TimedString } from '../voice/io.js';
import type { TurnHandlingOptions } from '../voice/turn_config/turn_handling.js';
import { AGENT_TEMPLATE_ID, AgentContextNotReadyError } from './types.js';
import type {
  AgentBuilderContext,
  AgentTemplate,
  AgentTemplateConfigureOptions,
  LLMNodeFn,
  RealtimeAudioOutputNodeFn,
  STTNodeFn,
  TTSNodeFn,
  ToolInput,
  TranscriptionNodeFn,
} from './types.js';

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

let nextTemplateId = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const templateRegistry = new Map<number, AgentTemplate<any>>();

/** @internal */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTemplateById(id: number): AgentTemplate<any> | undefined {
  return templateRegistry.get(id);
}

// ---------------------------------------------------------------------------
// Accumulated builder state
// ---------------------------------------------------------------------------

type _BuilderState = {
  configured: boolean;
  configureOptions: AgentTemplateConfigureOptions | null;
  tools: ToolContext;
  onEnterCb: (() => Promise<void>) | null;
  onExitCb: (() => Promise<void>) | null;
  onUserTurnCompletedCb: ((chatCtx: ChatContext, newMessage: ChatMessage) => Promise<void>) | null;
  sttNodeFn: STTNodeFn | null;
  llmNodeFn: LLMNodeFn | null;
  ttsNodeFn: TTSNodeFn | null;
  transcriptionNodeFn: TranscriptionNodeFn | null;
  realtimeAudioOutputNodeFn: RealtimeAudioOutputNodeFn | null;
};

// ---------------------------------------------------------------------------
// _FunctionalAgent (private subclass of voice.Agent)
// ---------------------------------------------------------------------------

class _FunctionalAgent extends Agent {
  readonly #onEnterCb: (() => Promise<void>) | null;
  readonly #onExitCb: (() => Promise<void>) | null;
  readonly #onUserTurnCompletedCb:
    | ((chatCtx: ChatContext, newMessage: ChatMessage) => Promise<void>)
    | null;
  readonly #sttNodeFn: STTNodeFn | null;
  readonly #llmNodeFn: LLMNodeFn | null;
  readonly #ttsNodeFn: TTSNodeFn | null;
  readonly #transcriptionNodeFn: TranscriptionNodeFn | null;
  readonly #realtimeAudioOutputNodeFn: RealtimeAudioOutputNodeFn | null;

  constructor(options: AgentOptions<unknown>, state: _BuilderState) {
    super(options);
    this.#onEnterCb = state.onEnterCb;
    this.#onExitCb = state.onExitCb;
    this.#onUserTurnCompletedCb = state.onUserTurnCompletedCb;
    this.#sttNodeFn = state.sttNodeFn;
    this.#llmNodeFn = state.llmNodeFn;
    this.#ttsNodeFn = state.ttsNodeFn;
    this.#transcriptionNodeFn = state.transcriptionNodeFn;
    this.#realtimeAudioOutputNodeFn = state.realtimeAudioOutputNodeFn;
  }

  override async onEnter(): Promise<void> {
    if (this.#onEnterCb) {
      await this.#onEnterCb();
    }
  }

  override async onExit(): Promise<void> {
    if (this.#onExitCb) {
      await this.#onExitCb();
    }
  }

  override async onUserTurnCompleted(chatCtx: ChatContext, newMessage: ChatMessage): Promise<void> {
    if (this.#onUserTurnCompletedCb) {
      await this.#onUserTurnCompletedCb(chatCtx, newMessage);
    }
  }

  override async sttNode(
    audio: ReadableStream<AudioFrame>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<SpeechEvent | string> | null> {
    if (!this.#sttNodeFn) {
      return Agent.default.sttNode(this, audio, modelSettings);
    }
    const asyncAudio = readableStreamToAsyncIterable(audio);
    const result = await this.#sttNodeFn(asyncAudio, modelSettings);
    return result ? asyncIterableToReadableStream(result) : null;
  }

  override async llmNode(
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<ChatChunk | string> | null> {
    if (!this.#llmNodeFn) {
      return Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings);
    }
    const result = await this.#llmNodeFn(chatCtx, toolCtx, modelSettings);
    return result ? asyncIterableToReadableStream(result) : null;
  }

  override async ttsNode(
    text: ReadableStream<string>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<AudioFrame> | null> {
    if (!this.#ttsNodeFn) {
      return Agent.default.ttsNode(this, text, modelSettings);
    }
    const asyncText = readableStreamToAsyncIterable(text);
    const result = await this.#ttsNodeFn(asyncText, modelSettings);
    return result ? asyncIterableToReadableStream(result) : null;
  }

  override async transcriptionNode(
    text: ReadableStream<string | TimedString>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<string | TimedString> | null> {
    if (!this.#transcriptionNodeFn) {
      return Agent.default.transcriptionNode(this, text, modelSettings);
    }
    const asyncText = readableStreamToAsyncIterable(text);
    const result = await this.#transcriptionNodeFn(asyncText, modelSettings);
    return result ? asyncIterableToReadableStream(result) : null;
  }

  override async realtimeAudioOutputNode(
    audio: ReadableStream<AudioFrame>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<AudioFrame> | null> {
    if (!this.#realtimeAudioOutputNodeFn) {
      return Agent.default.realtimeAudioOutputNode(this, audio, modelSettings);
    }
    const asyncAudio = readableStreamToAsyncIterable(audio);
    const result = await this.#realtimeAudioOutputNodeFn(asyncAudio, modelSettings);
    return result ? asyncIterableToReadableStream(result) : null;
  }
}

// ---------------------------------------------------------------------------
// Runtime getter helper
// ---------------------------------------------------------------------------

function runtimeGetter<T>(
  agentRef: { current: Agent | null },
  propertyName: string,
  accessor: (agent: Agent) => T,
): T {
  if (!agentRef.current) {
    throw new AgentContextNotReadyError(propertyName);
  }
  return accessor(agentRef.current);
}

// ---------------------------------------------------------------------------
// createAgentTemplate
// ---------------------------------------------------------------------------

export function createAgentTemplate<Props = void>(
  builder: (ctx: AgentBuilderContext, props: Props) => void,
): AgentTemplate<Props> {
  const templateId = nextTemplateId++;

  const factory = ((...args: Props extends void ? [] : [props: Props]): Agent => {
    const props = args[0] as Props;
    const agentRef: { current: Agent | null } = { current: null };

    const state: _BuilderState = {
      configured: false,
      configureOptions: null,
      tools: {},
      onEnterCb: null,
      onExitCb: null,
      onUserTurnCompletedCb: null,
      sttNodeFn: null,
      llmNodeFn: null,
      ttsNodeFn: null,
      transcriptionNodeFn: null,
      realtimeAudioOutputNodeFn: null,
    };

    // --- Build the context object ---

    const ctx: AgentBuilderContext = {
      configure(options: AgentTemplateConfigureOptions): void {
        if (state.configured) {
          throw new Error('ctx.configure() can only be called once per agent definition.');
        }
        state.configured = true;
        state.configureOptions = options;
      },

      tool(name: string, toolInput: ToolInput) {
        if (name in state.tools) {
          throw new Error(
            `Tool '${name}' is already registered. Each tool must have a unique name.`,
          );
        }
        if (isFunctionTool(toolInput)) {
          state.tools[name] = toolInput;
        } else if (toolInput.parameters) {
          state.tools[name] = tool({
            description: toolInput.description,
            parameters: toolInput.parameters as ToolInputSchema<JSONObject>,
            execute: toolInput.execute as ToolExecuteFunction<JSONObject>,
            flags: toolInput.flags,
          });
        } else {
          state.tools[name] = tool({
            description: toolInput.description,
            execute: toolInput.execute as ToolExecuteFunction<Record<string, never>>,
            flags: toolInput.flags,
          });
        }
      },

      onEnter(callback: () => Promise<void>): void {
        state.onEnterCb = callback;
      },
      onExit(callback: () => Promise<void>): void {
        state.onExitCb = callback;
      },
      onUserTurnCompleted(
        callback: (chatCtx: ChatContext, newMessage: ChatMessage) => Promise<void>,
      ): void {
        state.onUserTurnCompletedCb = callback;
      },

      sttNode(fn: STTNodeFn): void {
        state.sttNodeFn = fn;
      },
      llmNode(fn: LLMNodeFn): void {
        state.llmNodeFn = fn;
      },
      ttsNode(fn: TTSNodeFn): void {
        state.ttsNodeFn = fn;
      },
      transcriptionNode(fn: TranscriptionNodeFn): void {
        state.transcriptionNodeFn = fn;
      },
      realtimeAudioOutputNode(fn: RealtimeAudioOutputNodeFn): void {
        state.realtimeAudioOutputNodeFn = fn;
      },

      async defaultSttNode(
        audio: AsyncIterable<AudioFrame>,
        modelSettings: ModelSettings,
      ): Promise<AsyncIterable<SpeechEvent | string>> {
        const agent = runtimeGetter(agentRef, 'defaultSttNode', (a) => a);
        const stream = await Agent.default.sttNode(
          agent,
          asyncIterableToReadableStream(audio),
          modelSettings,
        );
        if (!stream) {
          return (async function* () {})();
        }
        return readableStreamToAsyncIterable(stream);
      },

      async defaultLlmNode(
        chatCtx: ChatContext,
        toolCtx: ToolContext,
        modelSettings: ModelSettings,
      ): Promise<AsyncIterable<ChatChunk | string>> {
        const agent = runtimeGetter(agentRef, 'defaultLlmNode', (a) => a);
        const stream = await Agent.default.llmNode(agent, chatCtx, toolCtx, modelSettings);
        if (!stream) {
          return (async function* () {})();
        }
        return readableStreamToAsyncIterable(stream);
      },

      async defaultTtsNode(
        text: AsyncIterable<string>,
        modelSettings: ModelSettings,
      ): Promise<AsyncIterable<AudioFrame>> {
        const agent = runtimeGetter(agentRef, 'defaultTtsNode', (a) => a);
        const stream = await Agent.default.ttsNode(
          agent,
          asyncIterableToReadableStream(text),
          modelSettings,
        );
        if (!stream) {
          return (async function* () {})();
        }
        return readableStreamToAsyncIterable(stream);
      },

      async defaultTranscriptionNode(
        text: AsyncIterable<string | TimedString>,
        modelSettings: ModelSettings,
      ): Promise<AsyncIterable<string | TimedString>> {
        const agent = runtimeGetter(agentRef, 'defaultTranscriptionNode', (a) => a);
        const stream = await Agent.default.transcriptionNode(
          agent,
          asyncIterableToReadableStream(text),
          modelSettings,
        );
        if (!stream) {
          return (async function* () {})();
        }
        return readableStreamToAsyncIterable(stream);
      },

      async defaultRealtimeAudioOutputNode(
        audio: AsyncIterable<AudioFrame>,
        modelSettings: ModelSettings,
      ): Promise<AsyncIterable<AudioFrame>> {
        const agent = runtimeGetter(agentRef, 'defaultRealtimeAudioOutputNode', (a) => a);
        const stream = await Agent.default.realtimeAudioOutputNode(
          agent,
          asyncIterableToReadableStream(audio),
          modelSettings,
        );
        if (!stream) {
          return (async function* () {})();
        }
        return readableStreamToAsyncIterable(stream);
      },

      // Runtime getters
      get session(): AgentSession {
        return runtimeGetter(agentRef, 'session', (a) => a.session);
      },
      get chatCtx(): ReadonlyChatContext {
        return runtimeGetter(agentRef, 'chatCtx', (a) => a.chatCtx);
      },
      get toolCtx(): ToolContext {
        return runtimeGetter(agentRef, 'toolCtx', (a) => a.toolCtx);
      },
      get id(): string {
        return runtimeGetter(agentRef, 'id', (a) => a.id);
      },
      get instructions(): string {
        return runtimeGetter(agentRef, 'instructions', (a) => a.instructions);
      },
      get stt(): STT | undefined {
        return runtimeGetter(agentRef, 'stt', (a) => a.stt);
      },
      get llm(): LLM | RealtimeModel | undefined {
        return runtimeGetter(agentRef, 'llm', (a) => a.llm);
      },
      get tts(): TTS | undefined {
        return runtimeGetter(agentRef, 'tts', (a) => a.tts);
      },
      get vad(): VAD | undefined {
        return runtimeGetter(agentRef, 'vad', (a) => a.vad);
      },
      get turnHandling(): Partial<TurnHandlingOptions> | undefined {
        return runtimeGetter(agentRef, 'turnHandling', (a) => a.turnHandling);
      },
      get minConsecutiveSpeechDelay(): number | undefined {
        return runtimeGetter(
          agentRef,
          'minConsecutiveSpeechDelay',
          (a) => a.minConsecutiveSpeechDelay,
        );
      },
    };

    // --- Run the builder ---
    builder(ctx, props);

    // --- Validate & construct ---
    if (!state.configureOptions) {
      throw new Error(
        'ctx.configure() must be called during agent definition to provide at least `instructions`.',
      );
    }

    const agentOptions: AgentOptions<unknown> = {
      ...state.configureOptions,
      id: `functional_agent_${templateId}`,
      tools: Object.keys(state.tools).length > 0 ? state.tools : undefined,
    };

    const agent = new _FunctionalAgent(agentOptions, state);
    agentRef.current = agent;

    return agent;
  }) as AgentTemplate<Props>;

  Object.defineProperty(factory, AGENT_TEMPLATE_ID, { value: templateId, writable: false });
  templateRegistry.set(templateId, factory);

  return factory;
}
