// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
  RealtimeModelError,
} from '../llm/index.js';
import type { LLM, RealtimeModel } from '../llm/index.js';
import type { LLMError } from '../llm/llm.js';
import type { AgentMetrics } from '../metrics/base.js';
import type { STT } from '../stt/index.js';
import type { STTError } from '../stt/stt.js';
import type { TTS } from '../tts/index.js';
import type { TTSError } from '../tts/tts.js';
import type { SpeechHandle } from './speech_handle.js';

export enum AgentSessionEventTypes {
  UserInputTranscribed = 'user_input_transcribed',
  AgentStateChanged = 'agent_state_changed',
  UserStateChanged = 'user_state_changed',
  ConversationItemAdded = 'conversation_item_added',
  FunctionToolsExecuted = 'function_tools_executed',
  MetricsCollected = 'metrics_collected',
  SpeechCreated = 'speech_created',
  Error = 'error',
  Close = 'close',
}

export type UserState = 'speaking' | 'listening' | 'away';
export type AgentState = 'initializing' | 'idle' | 'listening' | 'thinking' | 'speaking';

export enum CloseReason {
  ERROR = 'error',
  JOB_SHUTDOWN = 'job_shutdown',
  PARTICIPANT_DISCONNECTED = 'participant_disconnected',
  USER_INITIATED = 'user_initiated',
}

export type SpeechSource = 'say' | 'generate_reply' | 'tool_response';

export type UserStateChangedEvent = {
  type: 'user_state_changed';
  oldState: UserState;
  newState: UserState;
  createdAt: number;
};

export const createUserStateChangedEvent = (
  oldState: UserState,
  newState: UserState,
  createdAt: number = Date.now(),
): UserStateChangedEvent => ({
  type: 'user_state_changed',
  oldState,
  newState,
  createdAt,
});

export type AgentStateChangedEvent = {
  type: 'agent_state_changed';
  oldState: AgentState;
  newState: AgentState;
  createdAt: number;
};

export const createAgentStateChangedEvent = (
  oldState: AgentState,
  newState: AgentState,
  createdAt: number = Date.now(),
): AgentStateChangedEvent => ({
  type: 'agent_state_changed',
  oldState,
  newState,
  createdAt,
});

export type UserInputTranscribedEvent = {
  type: 'user_input_transcribed';
  transcript: string;
  isFinal: boolean;
  // TODO(AJS-106): add multi participant support
  /** Not supported yet. Always null by default. */
  speakerId: string | null;
  createdAt: number;
  language: string | null;
};

export const createUserInputTranscribedEvent = ({
  transcript,
  isFinal,
  speakerId = null,
  language = null,
  createdAt = Date.now(),
}: {
  transcript: string;
  isFinal: boolean;
  speakerId?: string | null;
  language?: string | null;
  createdAt?: number;
}): UserInputTranscribedEvent => ({
  type: 'user_input_transcribed',
  transcript,
  isFinal,
  speakerId,
  language,
  createdAt,
});

export type MetricsCollectedEvent = {
  type: 'metrics_collected';
  metrics: AgentMetrics;
  createdAt: number;
};

export const createMetricsCollectedEvent = ({
  metrics,
  createdAt = Date.now(),
}: {
  metrics: AgentMetrics;
  createdAt?: number;
}): MetricsCollectedEvent => ({
  type: 'metrics_collected',
  metrics,
  createdAt,
});

export type ConversationItemAddedEvent = {
  type: 'conversation_item_added';
  item: ChatMessage;
  createdAt: number;
};

export const createConversationItemAddedEvent = (
  item: ChatMessage,
  createdAt: number = Date.now(),
): ConversationItemAddedEvent => ({
  type: 'conversation_item_added',
  item,
  createdAt,
});

export type FunctionToolsExecutedEvent = {
  type: 'function_tools_executed';
  functionCalls: FunctionCall[];
  functionCallOutputs: FunctionCallOutput[];
  createdAt: number;
};

export const createFunctionToolsExecutedEvent = ({
  functionCalls,
  functionCallOutputs,
  createdAt = Date.now(),
}: {
  functionCalls: FunctionCall[];
  functionCallOutputs: FunctionCallOutput[];
  createdAt?: number;
}): FunctionToolsExecutedEvent => {
  return {
    type: 'function_tools_executed',
    functionCalls,
    functionCallOutputs,
    createdAt,
  };
};

export const zipFunctionCallsAndOutputs = (
  event: FunctionToolsExecutedEvent,
): Array<[FunctionCall, FunctionCallOutput]> => {
  return event.functionCalls.map((call, index) => [call, event.functionCallOutputs[index]!]);
};

export type SpeechCreatedEvent = {
  type: 'speech_created';
  /**
   * True if the speech was created using public methods like `say` or `generate_reply`
   */
  userInitiated: boolean;
  /**
   * Source indicating how the speech handle was created
   */
  source: SpeechSource;
  /**
   * The speech handle that was created
   */
  // TODO(shubhra): we need to make sure this doesn't get serialized
  speechHandle: SpeechHandle;
  /**
   * The timestamp when the speech handle was created
   */
  createdAt: number;
};

export const createSpeechCreatedEvent = ({
  userInitiated,
  source,
  speechHandle,
  createdAt = Date.now(),
}: {
  userInitiated: boolean;
  source: SpeechSource;
  speechHandle: SpeechHandle;
  createdAt?: number;
}): SpeechCreatedEvent => ({
  type: 'speech_created',
  userInitiated,
  source,
  speechHandle,
  createdAt,
});

export type ErrorEvent = {
  type: 'error';
  error: RealtimeModelError | STTError | TTSError | LLMError | unknown;
  source: LLM | STT | TTS | RealtimeModel | unknown;
  createdAt: number;
};

export const createErrorEvent = (
  error: RealtimeModelError | STTError | TTSError | LLMError | unknown,
  source: LLM | STT | TTS | RealtimeModel | unknown,
  createdAt: number = Date.now(),
): ErrorEvent => ({
  type: 'error',
  error,
  source,
  createdAt,
});

export type CloseEvent = {
  type: 'close';
  error: RealtimeModelError | STTError | TTSError | LLMError | null;
  reason: CloseReason;
  createdAt: number;
};

export const createCloseEvent = (
  reason: CloseReason,
  error: RealtimeModelError | STTError | TTSError | LLMError | null = null,
  createdAt: number = Date.now(),
): CloseEvent => ({
  type: 'close',
  error,
  reason,
  createdAt,
});

export type AgentEvent =
  | UserInputTranscribedEvent
  | UserStateChangedEvent
  | AgentStateChangedEvent
  | MetricsCollectedEvent
  | ConversationItemAddedEvent
  | FunctionToolsExecutedEvent
  | SpeechCreatedEvent
  | ErrorEvent
  | CloseEvent;
