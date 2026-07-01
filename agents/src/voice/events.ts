// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { InterruptionDetectionError } from '../inference/interruption/errors.js';
import type { OverlappingSpeechEvent } from '../inference/interruption/types.js';
import type { LanguageCode } from '../language.js';
import type {
  AgentHandoffItem,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
  LLM,
  RealtimeModel,
  RealtimeModelError,
} from '../llm/index.js';
import type { LLMError } from '../llm/llm.js';
import type { AgentMetrics } from '../metrics/base.js';
import type { STT } from '../stt/index.js';
import type { STTError } from '../stt/stt.js';
import type { TTS } from '../tts/index.js';
import type { TTSError } from '../tts/tts.js';
import type { AgentSessionUsage } from './agent_session.js';
import type { SpeechHandle } from './speech_handle.js';

export enum AgentSessionEventTypes {
  UserInputTranscribed = 'user_input_transcribed',
  AgentStateChanged = 'agent_state_changed',
  UserStateChanged = 'user_state_changed',
  ConversationItemAdded = 'conversation_item_added',
  FunctionToolsExecuted = 'function_tools_executed',
  ToolExecutionUpdated = 'tool_execution_updated',
  MetricsCollected = 'metrics_collected',
  SessionUsageUpdated = 'session_usage_updated',
  DebugMessage = 'debug_message',
  SpeechCreated = 'speech_created',
  AgentFalseInterruption = 'agent_false_interruption',
  OverlappingSpeech = 'overlapping_speech',
  /** Audio EOT detector emitted a per-turn prediction. */
  EotPrediction = 'eot_prediction',
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

export type ShutdownReason = CloseReason | string;

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
  /** Provider-specific ID for the transcribed input item, when available. */
  itemId: string | null;
  // TODO(AJS-106): add multi participant support
  /** Not supported yet. Always null by default. */
  speakerId: string | null;
  createdAt: number;
  language: LanguageCode | null;
};

export const createUserInputTranscribedEvent = ({
  transcript,
  isFinal,
  itemId = null,
  speakerId = null,
  language = null,
  createdAt = Date.now(),
}: {
  transcript: string;
  isFinal: boolean;
  itemId?: string | null;
  speakerId?: string | null;
  language?: LanguageCode | null;
  createdAt?: number;
}): UserInputTranscribedEvent => ({
  type: 'user_input_transcribed',
  transcript,
  isFinal,
  itemId,
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

export type SessionUsageUpdatedEvent = {
  type: 'session_usage_updated';
  usage: AgentSessionUsage;
  createdAt: number;
};

export const createSessionUsageUpdatedEvent = ({
  usage,
  createdAt = Date.now(),
}: {
  usage: AgentSessionUsage;
  createdAt?: number;
}): SessionUsageUpdatedEvent => ({
  type: 'session_usage_updated',
  usage,
  createdAt,
});

export type ConversationItemAddedEvent = {
  type: 'conversation_item_added';
  item: ChatMessage | AgentHandoffItem;
  createdAt: number;
};

export const createConversationItemAddedEvent = (
  item: ChatMessage | AgentHandoffItem,
  createdAt: number = Date.now(),
): ConversationItemAddedEvent => ({
  type: 'conversation_item_added',
  item,
  createdAt,
});

export type FunctionToolsExecutedEvent = {
  type: 'function_tools_executed';
  /**
   * Function calls and outputs are parallel arrays: the output at a given index
   * belongs to the call at the same index, and its `callId` matches the paired
   * function call's `callId`.
   */
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
  // Pair calls with outputs by list position.
  return event.functionCalls.map((call, index) => [call, event.functionCallOutputs[index]!]);
};

export type ToolCallStarted = {
  type: 'tool_call_started';
  functionCall: FunctionCall;
};

export type ToolCallUpdated = {
  type: 'tool_call_updated';
  /** Entry id: `callId` inline, `${callId}_update_N` when deferred. */
  id: string;
  callId: string;
  message: string;
};

export type ToolCallEnded = {
  type: 'tool_call_ended';
  /** Entry id: `callId` inline, `${callId}_final` when deferred. */
  id: string;
  callId: string;
  /** Result or error text; null when there is nothing to voice. */
  message: string | null;
  status: 'done' | 'error' | 'cancelled';
};

export type ToolReplyUpdated = {
  type: 'tool_reply_updated';
  /** `ToolCallUpdated.id` / `ToolCallEnded.id` values this reply covers. */
  updateIds: string[];
  status: 'scheduled' | 'completed' | 'interrupted' | 'skipped';
  /** Id of the reply speech; `speech_created` carries its handle. */
  speechId: string;
};

export type ToolExecutionUpdate =
  | ToolCallStarted
  | ToolCallUpdated
  | ToolCallEnded
  | ToolReplyUpdated;

export type ToolExecutionUpdatedEvent = {
  type: 'tool_execution_updated';
  update: ToolExecutionUpdate;
  createdAt: number;
};

export const createToolExecutionUpdatedEvent = (
  update: ToolExecutionUpdate,
  createdAt: number = Date.now(),
): ToolExecutionUpdatedEvent => ({
  type: 'tool_execution_updated',
  update,
  createdAt,
});

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

/**
 * Audio EOT prediction landed on the wire. Emitted once per turn boundary
 * decision when a `TurnDetector` is wired into the session.
 */
export type EotPredictionEvent = {
  type: 'eot_prediction';
  /** End-of-turn probability in [0, 1] returned by the detector. */
  probability: number;
  /** Threshold below which the detector treats the prediction as unlikely. */
  threshold: number;
  /** Model-side inference time, in milliseconds. */
  inferenceDurationMs: number;
  /** End-of-speech → prediction receive time, in milliseconds. */
  delayMs: number;
  createdAt: number;
};

export const createEotPredictionEvent = ({
  probability,
  threshold,
  inferenceDurationMs,
  delayMs,
  createdAt = Date.now(),
}: {
  probability: number;
  threshold: number;
  inferenceDurationMs: number;
  delayMs: number;
  createdAt?: number;
}): EotPredictionEvent => ({
  type: 'eot_prediction',
  probability,
  threshold,
  inferenceDurationMs,
  delayMs,
  createdAt,
});

/**
 * Internal: a window in which the agent could backchannel (a short acknowledgment
 * such as "mm-hmm"), as predicted by the turn detector. Passed to `AgentActivity`
 * only — not surfaced as a public `AgentSession` event (absent from `AgentEvent`,
 * `AgentSessionEventTypes`, and the package exports).
 *
 * `AgentActivity` owns the decision of what to do with it. The end-of-turn margin
 * (`endOfTurnThreshold - endOfTurnProbability`) gives a progressive risk axis: a
 * large positive margin means the user is clearly still going, so riskier
 * backchannels (yeah/okay/right) are safe; a small margin (or a negative one,
 * where `endOfTurnProbability >= endOfTurnThreshold` and a reply is imminent)
 * calls for safe, less ambiguous ones (hmm/uh-huh) that won't collide with the reply.
 *
 * @internal
 */
export type _AgentBackchannelOpportunityEvent = {
  type: 'agent_backchannel_opportunity';
  probability: number;
  threshold: number;
  endOfTurnProbability: number;
  endOfTurnThreshold: number;
  language?: string;
  createdAt: number;
};

/** @internal */
export const _createAgentBackchannelOpportunityEvent = ({
  probability,
  threshold,
  endOfTurnProbability,
  endOfTurnThreshold,
  language,
  createdAt = Date.now(),
}: {
  probability: number;
  threshold: number;
  endOfTurnProbability: number;
  endOfTurnThreshold: number;
  language?: string;
  createdAt?: number;
}): _AgentBackchannelOpportunityEvent => ({
  type: 'agent_backchannel_opportunity',
  probability,
  threshold,
  endOfTurnProbability,
  endOfTurnThreshold,
  language,
  createdAt,
});

export type UserTurnExceededEvent = {
  type: 'user_turn_exceeded';
  /** Transcript from the current uncommitted user turn only. */
  transcript: string;
  /** Full transcript since the start of user speaking in the accumulation window. */
  accumulatedTranscript: string;
  /** Total word count since the start of user speaking in the accumulation window. */
  accumulatedWordCount: number;
  /** Duration of the user turn accumulation window in milliseconds. */
  duration: number;
  createdAt: number;
};

export const createUserTurnExceededEvent = ({
  transcript,
  accumulatedTranscript,
  accumulatedWordCount,
  duration,
  createdAt = Date.now(),
}: {
  transcript: string;
  accumulatedTranscript: string;
  accumulatedWordCount: number;
  duration: number;
  createdAt?: number;
}): UserTurnExceededEvent => ({
  type: 'user_turn_exceeded',
  transcript,
  accumulatedTranscript,
  accumulatedWordCount,
  duration,
  createdAt,
});

export type ErrorEvent = {
  type: 'error';
  error: RealtimeModelError | STTError | TTSError | LLMError | InterruptionDetectionError;
  source?: LLM | STT | TTS | RealtimeModel;
  createdAt: number;
};

export const createErrorEvent = (
  error: RealtimeModelError | STTError | TTSError | LLMError | InterruptionDetectionError,
  source?: LLM | STT | TTS | RealtimeModel,
  createdAt: number = Date.now(),
): ErrorEvent => ({
  type: 'error',
  error,
  source,
  createdAt,
});

export type CloseEvent = {
  type: 'close';
  error: RealtimeModelError | STTError | TTSError | LLMError | InterruptionDetectionError | null;
  reason: ShutdownReason;
  createdAt: number;
};

export const createCloseEvent = (
  reason: ShutdownReason,
  error:
    | RealtimeModelError
    | STTError
    | TTSError
    | LLMError
    | InterruptionDetectionError
    | null = null,
  createdAt: number = Date.now(),
): CloseEvent => ({
  type: 'close',
  error,
  reason,
  createdAt,
});

export type AgentFalseInterruptionEvent = {
  type: 'agent_false_interruption';
  /** Whether the false interruption was resumed automatically. */
  resumed: boolean;
  createdAt: number;
};

export const createAgentFalseInterruptionEvent = ({
  resumed,
  createdAt = Date.now(),
}: {
  resumed: boolean;
  createdAt?: number;
}): AgentFalseInterruptionEvent => ({
  type: 'agent_false_interruption',
  resumed,
  createdAt,
});

export type AgentEvent =
  | UserInputTranscribedEvent
  | UserStateChangedEvent
  | AgentStateChangedEvent
  | MetricsCollectedEvent
  | SessionUsageUpdatedEvent
  | ConversationItemAddedEvent
  | FunctionToolsExecutedEvent
  | ToolExecutionUpdatedEvent
  | SpeechCreatedEvent
  | AgentFalseInterruptionEvent
  | OverlappingSpeechEvent
  | ErrorEvent
  | CloseEvent;
