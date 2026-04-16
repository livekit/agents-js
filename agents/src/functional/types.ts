// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { Throws } from '@livekit/throws-transformer/throws';
import type { LLMModels, STTModelString, TTSModelString } from '../inference/index.js';
import type { ReadonlyChatContext } from '../llm/chat_context.js';
import type {
  ChatChunk,
  ChatContext,
  ChatMessage,
  FunctionTool,
  LLM,
  RealtimeModel,
} from '../llm/index.js';
import { type ToolContext } from '../llm/index.js';
import type {
  InferToolInput,
  JSONObject,
  ToolExecuteFunction,
  ToolInputSchema,
  ToolOptions,
} from '../llm/tool_context.js';
import type { STT, SpeechEvent } from '../stt/index.js';
import type { TTS } from '../tts/index.js';
import type { VAD } from '../vad.js';
import type { Agent, ModelSettings } from '../voice/agent.js';
import type { AgentSession } from '../voice/agent_session.js';
import type { TimedString } from '../voice/io.js';
import type { TurnHandlingOptions } from '../voice/turn_config/turn_handling.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a runtime-only property on {@link AgentBuilderContext} is accessed
 * during the agent definition callback, before the agent instance exists.
 */
export class AgentContextNotReadyError extends Error {
  constructor(propertyName: string) {
    super(
      `ctx.${propertyName} is not available during agent definition. ` +
        'It can only be accessed inside hook callbacks (onEnter, onExit, onUserTurnCompleted) ' +
        'or tool execute functions.',
    );
    this.name = 'AgentContextNotReadyError';
  }
}

// ---------------------------------------------------------------------------
// Template identity
// ---------------------------------------------------------------------------

export const AGENT_TEMPLATE_ID = Symbol.for('AGENT_TEMPLATE_ID');

// ---------------------------------------------------------------------------
// Pipeline node function types (user-facing, AsyncIterable-based)
// ---------------------------------------------------------------------------

export type STTNodeFn = (
  audio: AsyncIterable<AudioFrame>,
  modelSettings: ModelSettings,
) => Promise<AsyncIterable<SpeechEvent | string> | null>;

export type LLMNodeFn = (
  chatCtx: ChatContext,
  toolCtx: ToolContext,
  modelSettings: ModelSettings,
) => Promise<AsyncIterable<ChatChunk | string> | null>;

export type TTSNodeFn = (
  text: AsyncIterable<string>,
  modelSettings: ModelSettings,
) => Promise<AsyncIterable<AudioFrame> | null>;

export type TranscriptionNodeFn = (
  text: AsyncIterable<string | TimedString>,
  modelSettings: ModelSettings,
) => Promise<AsyncIterable<string | TimedString> | null>;

export type RealtimeAudioOutputNodeFn = (
  audio: AsyncIterable<AudioFrame>,
  modelSettings: ModelSettings,
) => Promise<AsyncIterable<AudioFrame> | null>;

// ---------------------------------------------------------------------------
// Configure options (subset of AgentOptions, minus id and tools)
// ---------------------------------------------------------------------------

export interface AgentTemplateConfigureOptions {
  instructions: string;
  chatCtx?: ChatContext;
  stt?: STT | STTModelString;
  vad?: VAD;
  llm?: LLM | RealtimeModel | LLMModels;
  tts?: TTS | TTSModelString;
  turnHandling?: TurnHandlingOptions;
  minConsecutiveSpeechDelay?: number;
  useTtsAlignedTranscript?: boolean;
}

// ---------------------------------------------------------------------------
// Tool input: either a pre-built FunctionTool or inline { description, ... }
// ---------------------------------------------------------------------------

export interface InlineToolDefinition<
  Schema extends ToolInputSchema = ToolInputSchema,
  Result = unknown,
> {
  description: string;
  parameters?: Schema;
  execute: ToolExecuteFunction<InferToolInput<Schema>, unknown, Result>;
  flags?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolInput = FunctionTool<any, any, any> | InlineToolDefinition<any, any>;

// ---------------------------------------------------------------------------
// AgentBuilderContext
// ---------------------------------------------------------------------------

export interface AgentBuilderContext {
  /** Configure agent models and pipeline settings. Must be called exactly once. */
  configure(options: AgentTemplateConfigureOptions): void;

  /** Register a pre-built `FunctionTool` (from `llm.tool(...)`). */
  tool<P extends JSONObject, U, R>(name: string, toolInput: FunctionTool<P, U, R>): void;
  /** Register an inline tool with parameters. */
  tool<Input, Result = unknown>(
    name: string,
    toolInput: {
      description: string;
      parameters: ToolInputSchema<Input>;
      execute: (args: Input, opts: ToolOptions) => Promise<Result>;
      flags?: number;
    },
  ): void;
  /** Register an inline tool without parameters. */
  tool<Result = unknown>(
    name: string,
    toolInput: {
      description: string;
      parameters?: never;
      execute: ToolExecuteFunction<Record<string, never>, unknown, Result>;
      flags?: number;
    },
  ): void;

  /** Register an `onEnter` lifecycle hook. */
  onEnter(callback: () => Promise<void>): void;
  /** Register an `onExit` lifecycle hook. */
  onExit(callback: () => Promise<void>): void;
  /** Register an `onUserTurnCompleted` lifecycle hook. */
  onUserTurnCompleted(
    callback: (chatCtx: ChatContext, newMessage: ChatMessage) => Promise<void>,
  ): void;

  /** Override the STT pipeline node (async generator). */
  sttNode(fn: STTNodeFn): void;
  /** Override the LLM pipeline node (async generator). */
  llmNode(fn: LLMNodeFn): void;
  /** Override the TTS pipeline node (async generator). */
  ttsNode(fn: TTSNodeFn): void;
  /** Override the transcription pipeline node (async generator). */
  transcriptionNode(fn: TranscriptionNodeFn): void;
  /** Override the realtime audio output pipeline node (async generator). */
  realtimeAudioOutputNode(fn: RealtimeAudioOutputNodeFn): void;

  /** Call the default STT node implementation and return an AsyncIterable. */
  defaultSttNode(
    audio: AsyncIterable<AudioFrame>,
    modelSettings: ModelSettings,
  ): Promise<AsyncIterable<SpeechEvent | string>>;
  /** Call the default LLM node implementation and return an AsyncIterable. */
  defaultLlmNode(
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
  ): Promise<AsyncIterable<ChatChunk | string>>;
  /** Call the default TTS node implementation and return an AsyncIterable. */
  defaultTtsNode(
    text: AsyncIterable<string>,
    modelSettings: ModelSettings,
  ): Promise<AsyncIterable<AudioFrame>>;
  /** Call the default transcription node implementation and return an AsyncIterable. */
  defaultTranscriptionNode(
    text: AsyncIterable<string | TimedString>,
    modelSettings: ModelSettings,
  ): Promise<AsyncIterable<string | TimedString>>;
  /** Call the default realtime audio output node implementation and return an AsyncIterable. */
  defaultRealtimeAudioOutputNode(
    audio: AsyncIterable<AudioFrame>,
    modelSettings: ModelSettings,
  ): Promise<AsyncIterable<AudioFrame>>;

  /**
   * Runtime getters — available inside hook callbacks and tool execute functions.
   * Throws `AgentContextNotReadyError` if accessed during the agent definition callback.
   */

  /** The agent session. */
  readonly session: Throws<AgentSession, AgentContextNotReadyError>;
  /** The chat context. */
  readonly chatCtx: Throws<ReadonlyChatContext, AgentContextNotReadyError>;
  /** The tool context. */
  readonly toolCtx: Throws<ToolContext, AgentContextNotReadyError>;
  /** The agent ID. */
  readonly id: Throws<string, AgentContextNotReadyError>;
  /** The agent instructions. */
  readonly instructions: Throws<string, AgentContextNotReadyError>;
  /** The STT model. */
  readonly stt: Throws<STT | undefined, AgentContextNotReadyError>;
  /** The LLM model. */
  readonly llm: Throws<LLM | RealtimeModel | undefined, AgentContextNotReadyError>;
  /** The TTS model. */
  readonly tts: Throws<TTS | undefined, AgentContextNotReadyError>;
  /** The VAD model. */
  readonly vad: Throws<VAD | undefined, AgentContextNotReadyError>;
  /** The turn handling options. */
  readonly turnHandling: Throws<
    Partial<TurnHandlingOptions> | undefined,
    AgentContextNotReadyError
  >;
  /** The minimum consecutive speech delay. */
  readonly minConsecutiveSpeechDelay: Throws<number | undefined, AgentContextNotReadyError>;
}

// ---------------------------------------------------------------------------
// AgentTemplate
// ---------------------------------------------------------------------------

export type AgentTemplate<Props = void> = (
  ...args: Props extends void ? [] : [props: Props]
) => Agent & { [AGENT_TEMPLATE_ID]: number };
