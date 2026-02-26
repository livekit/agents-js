// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Explicit wire-format converters that produce the exact JSON shape emitted by
// Python Pydantic models (snake_case keys, durations in seconds).
// The agents-playground frontend (types.ts / useClientEvents.ts) consumes this
// format directly via JSON.parse — any mismatch breaks the UI.
import { z } from 'zod';
import type {
  AgentHandoffItem,
  AudioContent,
  ChatContent,
  ChatItem,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
  ImageContent,
  MetricsReport,
} from '../llm/chat_context.js';
import type {
  AgentMetrics,
  EOUMetrics,
  InterruptionMetrics,
  LLMMetrics,
  MetricsMetadata,
  RealtimeModelMetrics,
  RealtimeModelMetricsCachedTokenDetails,
  RealtimeModelMetricsInputTokenDetails,
  RealtimeModelMetricsOutputTokenDetails,
  STTMetrics,
  TTSMetrics,
  VADMetrics,
} from '../metrics/base.js';
import type {
  InterruptionModelUsage,
  LLMModelUsage,
  ModelUsage,
  STTModelUsage,
  TTSModelUsage,
} from '../metrics/model_usage.js';
import type { AgentSessionUsage } from './agent_session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WireObject = Record<string, unknown>;

export function msToS(ms: number): number {
  return ms / 1000;
}

function omitUndefined(obj: WireObject): WireObject {
  const result: WireObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      result[k] = v;
    }
  }
  return result;
}

function imageContentToWire(img: ImageContent): WireObject {
  return omitUndefined({
    id: img.id,
    type: img.type,
    image: typeof img.image === 'string' ? img.image : undefined,
    inference_detail: img.inferenceDetail,
    inference_width: img.inferenceWidth,
    inference_height: img.inferenceHeight,
    mime_type: img.mimeType,
  });
}

function audioContentToWire(audio: AudioContent): WireObject {
  return omitUndefined({
    type: audio.type,
    transcript: audio.transcript,
  });
}

function chatContentToWire(content: ChatContent): unknown {
  if (typeof content === 'string') return content;
  if (content.type === 'image_content') return imageContentToWire(content);
  return audioContentToWire(content);
}

function metricsReportToWire(m: MetricsReport): WireObject {
  return omitUndefined({
    started_speaking_at: m.startedSpeakingAt,
    stopped_speaking_at: m.stoppedSpeakingAt,
    transcription_delay: m.transcriptionDelay,
    end_of_turn_delay: m.endOfTurnDelay,
    on_user_turn_completed_delay: m.onUserTurnCompletedDelay,
    llm_node_ttft: m.llmNodeTtft,
    tts_node_ttfb: m.ttsNodeTtfb,
    e2e_latency: m.e2eLatency,
  });
}

export function chatMessageToWire(msg: ChatMessage): WireObject {
  const result: WireObject = {
    id: msg.id,
    type: msg.type,
    role: msg.role,
    content: msg.content.map(chatContentToWire),
    interrupted: msg.interrupted,
    created_at: msToS(msg.createdAt),
  };

  if (msg.transcriptConfidence !== undefined) {
    result.transcript_confidence = msg.transcriptConfidence;
  }
  if (Object.keys(msg.metrics).length > 0) {
    result.metrics = metricsReportToWire(msg.metrics);
  }
  if (Object.keys(msg.extra).length > 0) {
    result.extra = msg.extra;
  }
  return result;
}

export function functionCallToWire(fc: FunctionCall): WireObject {
  const result: WireObject = {
    id: fc.id,
    type: fc.type,
    call_id: fc.callId,
    arguments: fc.args,
    name: fc.name,
    created_at: msToS(fc.createdAt),
  };

  if (Object.keys(fc.extra).length > 0) {
    result.extra = fc.extra;
  }
  if (fc.groupId !== undefined) {
    result.group_id = fc.groupId;
  }
  return result;
}

export function functionCallOutputToWire(fco: FunctionCallOutput): WireObject {
  return {
    id: fco.id,
    type: fco.type,
    name: fco.name,
    call_id: fco.callId,
    output: fco.output,
    is_error: fco.isError,
    created_at: msToS(fco.createdAt),
  };
}

export function agentHandoffToWire(ah: AgentHandoffItem): WireObject {
  const result: WireObject = {
    id: ah.id,
    type: ah.type,
    new_agent_id: ah.newAgentId,
    created_at: msToS(ah.createdAt),
  };
  if (ah.oldAgentId !== undefined) {
    result.old_agent_id = ah.oldAgentId;
  }
  return result;
}

export function chatItemToWire(item: ChatItem): WireObject {
  switch (item.type) {
    case 'message':
      return chatMessageToWire(item);
    case 'function_call':
      return functionCallToWire(item);
    case 'function_call_output':
      return functionCallOutputToWire(item);
    case 'agent_handoff':
      return agentHandoffToWire(item);
  }
}

function metadataToWire(m: MetricsMetadata | undefined): WireObject | null {
  if (!m) return null;
  return omitUndefined({
    model_name: m.modelName,
    model_provider: m.modelProvider,
  });
}

function llmMetricsToWire(m: LLMMetrics): WireObject {
  return omitUndefined({
    type: m.type,
    label: m.label,
    request_id: m.requestId,
    timestamp: msToS(m.timestamp),
    duration: msToS(m.durationMs),
    ttft: msToS(m.ttftMs),
    cancelled: m.cancelled,
    completion_tokens: m.completionTokens,
    prompt_tokens: m.promptTokens,
    prompt_cached_tokens: m.promptCachedTokens,
    total_tokens: m.totalTokens,
    tokens_per_second: m.tokensPerSecond,
    speech_id: m.speechId,
    metadata: metadataToWire(m.metadata),
  });
}

function sttMetricsToWire(m: STTMetrics): WireObject {
  return omitUndefined({
    type: m.type,
    label: m.label,
    request_id: m.requestId,
    timestamp: msToS(m.timestamp),
    duration: msToS(m.durationMs),
    audio_duration: msToS(m.audioDurationMs),
    input_tokens: m.inputTokens,
    output_tokens: m.outputTokens,
    streamed: m.streamed,
    metadata: metadataToWire(m.metadata),
  });
}

function ttsMetricsToWire(m: TTSMetrics): WireObject {
  return omitUndefined({
    type: m.type,
    label: m.label,
    request_id: m.requestId,
    timestamp: msToS(m.timestamp),
    ttfb: msToS(m.ttfbMs),
    duration: msToS(m.durationMs),
    audio_duration: msToS(m.audioDurationMs),
    cancelled: m.cancelled,
    characters_count: m.charactersCount,
    input_tokens: m.inputTokens,
    output_tokens: m.outputTokens,
    streamed: m.streamed,
    segment_id: m.segmentId,
    speech_id: m.speechId,
    metadata: metadataToWire(m.metadata),
  });
}

function vadMetricsToWire(m: VADMetrics): WireObject {
  return {
    type: m.type,
    label: m.label,
    timestamp: msToS(m.timestamp),
    idle_time: msToS(m.idleTimeMs),
    inference_duration_total: msToS(m.inferenceDurationTotalMs),
    inference_count: m.inferenceCount,
  };
}

function eouMetricsToWire(m: EOUMetrics): WireObject {
  return omitUndefined({
    type: m.type,
    timestamp: msToS(m.timestamp),
    end_of_utterance_delay: msToS(m.endOfUtteranceDelayMs),
    transcription_delay: msToS(m.transcriptionDelayMs),
    on_user_turn_completed_delay: msToS(m.onUserTurnCompletedDelayMs),
    speech_id: m.speechId,
  });
}

function cachedTokenDetailsToWire(d: RealtimeModelMetricsCachedTokenDetails): WireObject {
  return {
    audio_tokens: d.audioTokens,
    text_tokens: d.textTokens,
    image_tokens: d.imageTokens,
  };
}

function inputTokenDetailsToWire(d: RealtimeModelMetricsInputTokenDetails): WireObject {
  return omitUndefined({
    audio_tokens: d.audioTokens,
    text_tokens: d.textTokens,
    image_tokens: d.imageTokens,
    cached_tokens: d.cachedTokens,
    cached_tokens_details: d.cachedTokensDetails
      ? cachedTokenDetailsToWire(d.cachedTokensDetails)
      : undefined,
  });
}

function outputTokenDetailsToWire(d: RealtimeModelMetricsOutputTokenDetails): WireObject {
  return {
    text_tokens: d.textTokens,
    audio_tokens: d.audioTokens,
    image_tokens: d.imageTokens,
  };
}

function realtimeModelMetricsToWire(m: RealtimeModelMetrics): WireObject {
  return omitUndefined({
    type: m.type,
    label: m.label,
    request_id: m.requestId,
    timestamp: msToS(m.timestamp),
    duration: msToS(m.durationMs),
    session_duration: m.sessionDurationMs !== undefined ? msToS(m.sessionDurationMs) : undefined,
    ttft: msToS(m.ttftMs),
    cancelled: m.cancelled,
    input_tokens: m.inputTokens,
    output_tokens: m.outputTokens,
    total_tokens: m.totalTokens,
    tokens_per_second: m.tokensPerSecond,
    input_token_details: inputTokenDetailsToWire(m.inputTokenDetails),
    output_token_details: outputTokenDetailsToWire(m.outputTokenDetails),
    metadata: metadataToWire(m.metadata),
  });
}

// Ref: python metrics/base.py InterruptionMetrics
function interruptionMetricsToWire(m: InterruptionMetrics): WireObject {
  return omitUndefined({
    type: m.type,
    timestamp: msToS(m.timestamp),
    total_duration: msToS(m.totalDuration),
    prediction_duration: msToS(m.predictionDuration),
    detection_delay: msToS(m.detectionDelay),
    num_interruptions: m.numInterruptions,
    num_backchannels: m.numBackchannels,
    num_requests: m.numRequests,
    metadata: metadataToWire(m.metadata),
  });
}

export function agentMetricsToWire(m: AgentMetrics): WireObject {
  switch (m.type) {
    case 'llm_metrics':
      return llmMetricsToWire(m);
    case 'stt_metrics':
      return sttMetricsToWire(m);
    case 'tts_metrics':
      return ttsMetricsToWire(m);
    case 'vad_metrics':
      return vadMetricsToWire(m);
    case 'eou_metrics':
      return eouMetricsToWire(m);
    case 'realtime_model_metrics':
      return realtimeModelMetricsToWire(m);
    case 'interruption_metrics':
      return interruptionMetricsToWire(m);
  }
}

function llmModelUsageToWire(u: Partial<LLMModelUsage>): WireObject {
  return {
    type: u.type,
    provider: u.provider ?? '',
    model: u.model ?? '',
    input_tokens: u.inputTokens ?? 0,
    input_cached_tokens: u.inputCachedTokens ?? 0,
    input_audio_tokens: u.inputAudioTokens ?? 0,
    input_cached_audio_tokens: u.inputCachedAudioTokens ?? 0,
    input_text_tokens: u.inputTextTokens ?? 0,
    input_cached_text_tokens: u.inputCachedTextTokens ?? 0,
    input_image_tokens: u.inputImageTokens ?? 0,
    input_cached_image_tokens: u.inputCachedImageTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    output_audio_tokens: u.outputAudioTokens ?? 0,
    output_text_tokens: u.outputTextTokens ?? 0,
    session_duration: msToS(u.sessionDurationMs ?? 0),
  };
}

function ttsModelUsageToWire(u: Partial<TTSModelUsage>): WireObject {
  return {
    type: u.type,
    provider: u.provider ?? '',
    model: u.model ?? '',
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    characters_count: u.charactersCount ?? 0,
    audio_duration: msToS(u.audioDurationMs ?? 0),
  };
}

function sttModelUsageToWire(u: Partial<STTModelUsage>): WireObject {
  return {
    type: u.type,
    provider: u.provider ?? '',
    model: u.model ?? '',
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    audio_duration: msToS(u.audioDurationMs ?? 0),
  };
}

// Ref: python metrics/usage.py InterruptionModelUsage
function interruptionModelUsageToWire(u: Partial<InterruptionModelUsage>): WireObject {
  return {
    type: u.type,
    provider: u.provider ?? '',
    model: u.model ?? '',
    total_requests: u.totalRequests ?? 0,
  };
}

export function modelUsageToWire(u: Partial<ModelUsage>): WireObject {
  switch (u.type) {
    case 'llm_usage':
      return llmModelUsageToWire(u as Partial<LLMModelUsage>);
    case 'tts_usage':
      return ttsModelUsageToWire(u as Partial<TTSModelUsage>);
    case 'stt_usage':
      return sttModelUsageToWire(u as Partial<STTModelUsage>);
    case 'interruption_usage':
      return interruptionModelUsageToWire(u as Partial<InterruptionModelUsage>);
    default:
      return u as WireObject;
  }
}

export function agentSessionUsageToWire(u: AgentSessionUsage): WireObject {
  return {
    model_usage: u.modelUsage.map(modelUsageToWire),
  };
}

// ===========================================================================
// Zod wire-format schemas
// These validate the exact JSON shape that Python Pydantic emits on the wire.
// Inferred types via z.infer give fully typed parse results.
// ===========================================================================
const imageContentWireSchema = z.object({
  id: z.string(),
  type: z.literal('image_content'),
  image: z.string(),
  inference_detail: z.enum(['auto', 'high', 'low']).optional(),
  inference_width: z.number().optional(),
  inference_height: z.number().optional(),
  mime_type: z.string().optional(),
});

const audioContentWireSchema = z.object({
  type: z.literal('audio_content'),
  transcript: z.string().nullable().optional(),
});

const chatContentWireSchema = z.union([z.string(), imageContentWireSchema, audioContentWireSchema]);

const metricsReportWireSchema = z
  .object({
    started_speaking_at: z.number().optional(),
    stopped_speaking_at: z.number().optional(),
    transcription_delay: z.number().optional(),
    end_of_turn_delay: z.number().optional(),
    on_user_turn_completed_delay: z.number().optional(),
    llm_node_ttft: z.number().optional(),
    tts_node_ttfb: z.number().optional(),
    e2e_latency: z.number().optional(),
  })
  .optional();

export const chatMessageWireSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.enum(['developer', 'system', 'user', 'assistant']),
  content: z.array(chatContentWireSchema),
  interrupted: z.boolean(),
  created_at: z.number(),
  transcript_confidence: z.number().optional(),
  metrics: metricsReportWireSchema,
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const functionCallWireSchema = z.object({
  id: z.string(),
  type: z.literal('function_call'),
  call_id: z.string(),
  arguments: z.string(),
  name: z.string(),
  created_at: z.number(),
  extra: z.record(z.string(), z.unknown()).optional(),
  group_id: z.string().optional(),
});

export const functionCallOutputWireSchema = z.object({
  id: z.string(),
  type: z.literal('function_call_output'),
  name: z.string(),
  call_id: z.string(),
  output: z.string(),
  is_error: z.boolean(),
  created_at: z.number(),
});

export const agentHandoffWireSchema = z.object({
  id: z.string(),
  type: z.literal('agent_handoff'),
  new_agent_id: z.string(),
  created_at: z.number(),
  old_agent_id: z.string().optional(),
});

export const chatItemWireSchema = z.discriminatedUnion('type', [
  chatMessageWireSchema,
  functionCallWireSchema,
  functionCallOutputWireSchema,
  agentHandoffWireSchema,
]);

const metadataWireSchema = z
  .object({
    model_name: z.string().optional(),
    model_provider: z.string().optional(),
  })
  .nullable()
  .optional();

export const llmMetricsWireSchema = z.object({
  type: z.literal('llm_metrics'),
  label: z.string(),
  request_id: z.string(),
  timestamp: z.number(),
  duration: z.number(),
  ttft: z.number(),
  cancelled: z.boolean(),
  completion_tokens: z.number(),
  prompt_tokens: z.number(),
  prompt_cached_tokens: z.number(),
  total_tokens: z.number(),
  tokens_per_second: z.number(),
  speech_id: z.string().nullable().optional(),
  metadata: metadataWireSchema,
});

export const sttMetricsWireSchema = z.object({
  type: z.literal('stt_metrics'),
  label: z.string(),
  request_id: z.string(),
  timestamp: z.number(),
  duration: z.number(),
  audio_duration: z.number(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  streamed: z.boolean(),
  metadata: metadataWireSchema,
});

export const ttsMetricsWireSchema = z.object({
  type: z.literal('tts_metrics'),
  label: z.string(),
  request_id: z.string(),
  timestamp: z.number(),
  ttfb: z.number(),
  duration: z.number(),
  audio_duration: z.number(),
  cancelled: z.boolean(),
  characters_count: z.number(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  streamed: z.boolean(),
  segment_id: z.string().nullable().optional(),
  speech_id: z.string().nullable().optional(),
  metadata: metadataWireSchema,
});

export const vadMetricsWireSchema = z.object({
  type: z.literal('vad_metrics'),
  label: z.string(),
  timestamp: z.number(),
  idle_time: z.number(),
  inference_duration_total: z.number(),
  inference_count: z.number(),
});

export const eouMetricsWireSchema = z.object({
  type: z.literal('eou_metrics'),
  timestamp: z.number(),
  end_of_utterance_delay: z.number(),
  transcription_delay: z.number(),
  on_user_turn_completed_delay: z.number(),
  speech_id: z.string().nullable().optional(),
});

const cachedTokenDetailsWireSchema = z.object({
  audio_tokens: z.number(),
  text_tokens: z.number(),
  image_tokens: z.number(),
});

const inputTokenDetailsWireSchema = z.object({
  audio_tokens: z.number(),
  text_tokens: z.number(),
  image_tokens: z.number(),
  cached_tokens: z.number(),
  cached_tokens_details: cachedTokenDetailsWireSchema.nullable().optional(),
});

const outputTokenDetailsWireSchema = z.object({
  text_tokens: z.number(),
  audio_tokens: z.number(),
  image_tokens: z.number(),
});

export const realtimeModelMetricsWireSchema = z.object({
  type: z.literal('realtime_model_metrics'),
  label: z.string(),
  request_id: z.string(),
  timestamp: z.number(),
  duration: z.number(),
  session_duration: z.number().optional(),
  ttft: z.number(),
  cancelled: z.boolean(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  tokens_per_second: z.number(),
  input_token_details: inputTokenDetailsWireSchema,
  output_token_details: outputTokenDetailsWireSchema,
  metadata: metadataWireSchema,
});

export const interruptionMetricsWireSchema = z.object({
  type: z.literal('interruption_metrics'),
  timestamp: z.number(),
  total_duration: z.number(),
  prediction_duration: z.number(),
  detection_delay: z.number(),
  num_interruptions: z.number(),
  num_backchannels: z.number(),
  num_requests: z.number(),
  metadata: metadataWireSchema,
});

export const agentMetricsWireSchema = z.discriminatedUnion('type', [
  llmMetricsWireSchema,
  sttMetricsWireSchema,
  ttsMetricsWireSchema,
  vadMetricsWireSchema,
  eouMetricsWireSchema,
  realtimeModelMetricsWireSchema,
  interruptionMetricsWireSchema,
]);

// ---------------------------------------------------------------------------
// Model usage schemas
// ---------------------------------------------------------------------------

export const llmModelUsageWireSchema = z.object({
  type: z.literal('llm_usage'),
  provider: z.string().optional(),
  model: z.string().optional(),
  input_tokens: z.number().optional(),
  input_cached_tokens: z.number().optional(),
  input_audio_tokens: z.number().optional(),
  input_cached_audio_tokens: z.number().optional(),
  input_text_tokens: z.number().optional(),
  input_cached_text_tokens: z.number().optional(),
  input_image_tokens: z.number().optional(),
  input_cached_image_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  output_audio_tokens: z.number().optional(),
  output_text_tokens: z.number().optional(),
  session_duration: z.number().optional(),
});

export const ttsModelUsageWireSchema = z.object({
  type: z.literal('tts_usage'),
  provider: z.string().optional(),
  model: z.string().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  characters_count: z.number().optional(),
  audio_duration: z.number().optional(),
});

export const sttModelUsageWireSchema = z.object({
  type: z.literal('stt_usage'),
  provider: z.string().optional(),
  model: z.string().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  audio_duration: z.number().optional(),
});

export const interruptionModelUsageWireSchema = z.object({
  type: z.literal('interruption_usage'),
  provider: z.string().optional(),
  model: z.string().optional(),
  total_requests: z.number().optional(),
});

export const modelUsageWireSchema = z.discriminatedUnion('type', [
  llmModelUsageWireSchema,
  ttsModelUsageWireSchema,
  sttModelUsageWireSchema,
  interruptionModelUsageWireSchema,
]);

export const agentSessionUsageWireSchema = z.object({
  model_usage: z.array(modelUsageWireSchema),
});

// ---------------------------------------------------------------------------
// Client event schemas
// ---------------------------------------------------------------------------

const agentStateSchema = z.enum(['initializing', 'idle', 'listening', 'thinking', 'speaking']);
const userStateSchema = z.enum(['speaking', 'listening', 'away']);

export const clientAgentStateChangedSchema = z.object({
  type: z.literal('agent_state_changed'),
  old_state: agentStateSchema,
  new_state: agentStateSchema,
  created_at: z.number(),
});

export const clientUserStateChangedSchema = z.object({
  type: z.literal('user_state_changed'),
  old_state: userStateSchema,
  new_state: userStateSchema,
  created_at: z.number(),
});

export const clientConversationItemAddedSchema = z.object({
  type: z.literal('conversation_item_added'),
  item: chatMessageWireSchema,
  created_at: z.number(),
});

export const clientUserInputTranscribedSchema = z.object({
  type: z.literal('user_input_transcribed'),
  transcript: z.string(),
  is_final: z.boolean(),
  language: z.string().nullable(),
  created_at: z.number(),
});

export const clientFunctionToolsExecutedSchema = z.object({
  type: z.literal('function_tools_executed'),
  function_calls: z.array(functionCallWireSchema),
  function_call_outputs: z.array(functionCallOutputWireSchema.nullable()),
  created_at: z.number(),
});

export const clientMetricsCollectedSchema = z.object({
  type: z.literal('metrics_collected'),
  metrics: agentMetricsWireSchema,
  created_at: z.number(),
});

export const clientErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  created_at: z.number(),
});

export const clientUserOverlappingSpeechSchema = z.object({
  type: z.literal('user_overlapping_speech'),
  is_interruption: z.boolean(),
  created_at: z.number(),
  sent_at: z.number(),
  detection_delay: z.number(),
  overlap_started_at: z.number().nullable(),
});

export const clientSessionUsageSchema = z.object({
  type: z.literal('session_usage'),
  usage: agentSessionUsageWireSchema,
  created_at: z.number(),
});

export const clientEventSchema = z.discriminatedUnion('type', [
  clientAgentStateChangedSchema,
  clientUserStateChangedSchema,
  clientConversationItemAddedSchema,
  clientUserInputTranscribedSchema,
  clientFunctionToolsExecutedSchema,
  clientMetricsCollectedSchema,
  clientErrorSchema,
  clientUserOverlappingSpeechSchema,
  clientSessionUsageSchema,
]);

// ---------------------------------------------------------------------------
// RPC schemas
// ---------------------------------------------------------------------------

export const sendMessageRequestSchema = z.object({
  text: z.string(),
});

export const streamRequestSchema = z.object({
  request_id: z.string(),
  method: z.string(),
  payload: z.string(),
});

export const streamResponseSchema = z.object({
  request_id: z.string(),
  payload: z.string(),
  error: z.string().nullable().optional(),
});

export const getSessionStateResponseSchema = z.object({
  agent_state: agentStateSchema,
  user_state: userStateSchema,
  agent_id: z.string(),
  options: z.record(z.string(), z.unknown()),
  created_at: z.number(),
});

export const getChatHistoryResponseSchema = z.object({
  items: z.array(chatItemWireSchema),
});

export const getAgentInfoResponseSchema = z.object({
  id: z.string(),
  instructions: z.string().nullable(),
  tools: z.array(z.string()),
  chat_ctx: z.array(chatItemWireSchema),
});

export const sendMessageResponseSchema = z.object({
  items: z.array(chatItemWireSchema),
});

export const getRTCStatsResponseSchema = z.object({
  publisher_stats: z.array(z.record(z.string(), z.unknown())),
  subscriber_stats: z.array(z.record(z.string(), z.unknown())),
});

export const getSessionUsageResponseSchema = z.object({
  usage: agentSessionUsageWireSchema,
  created_at: z.number(),
});
