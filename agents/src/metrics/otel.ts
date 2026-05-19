// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { log } from '../log.js';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_LLM_METRICS,
  ATTR_REALTIME_MODEL_METRICS,
  ATTR_SPEECH_ID,
  ATTR_TTS_METRICS,
} from '../telemetry/trace_types.js';
import type { AgentSession } from '../voice/agent_session.js';
import { AgentSessionEventTypes, type MetricsCollectedEvent } from '../voice/events.js';
import type { AgentMetrics } from './base.js';

/** Distinct metric variants that map to OTel spans. */
export type OtelSpanVariant = 'llm' | 'stt' | 'tts' | 'eou' | 'realtime' | 'interruption' | 'vad';

export interface AttachOtelTracerOptions {
  /** Override default span names per metric variant. */
  spanNames?: Partial<Record<OtelSpanVariant, string>>;
}

const DEFAULT_SPAN_NAMES: Record<OtelSpanVariant, string> = {
  llm: 'gen_ai.chat',
  stt: 'gen_ai.transcribe',
  tts: 'gen_ai.synthesize',
  realtime: 'gen_ai.realtime',
  eou: 'lk.eou',
  interruption: 'lk.interruption',
  vad: 'lk.vad',
};

const GEN_AI_RESPONSE_ID = 'gen_ai.response.id';

/**
 * Subscribe to a session's `metrics_collected` events and emit OpenTelemetry spans
 * using the gen_ai semantic conventions.
 *
 * The helper picks up the active OTel context automatically, so wrapping calls in
 * `tracer.startActiveSpan(...)` produces per-turn parent spans.
 *
 * @param session - The AgentSession to observe.
 * @param tracer - An OpenTelemetry Tracer (e.g. from `trace.getTracer('voice-agent')`).
 * @param options - Optional overrides (currently: custom span names).
 * @returns Unsubscribe function. Call it to detach the listener.
 *
 * @example
 * ```ts
 * import { trace } from '@opentelemetry/api';
 * import { metrics } from '@livekit/agents';
 *
 * const tracer = trace.getTracer('voice-agent');
 * const detach = metrics.attachOtelTracer(session, tracer);
 * // ... later:
 * detach();
 * ```
 */
export function attachOtelTracer(
  session: AgentSession,
  tracer: Tracer,
  options: AttachOtelTracerOptions = {},
): () => void {
  const spanNames = { ...DEFAULT_SPAN_NAMES, ...options.spanNames };

  const handler = (ev: MetricsCollectedEvent) => {
    try {
      emitSpan(tracer, spanNames, ev.metrics);
    } catch (err) {
      // Resolve the logger lazily so callers don't have to initialize logging
      // just to attach a tracer.
      try {
        log().child({ err }).warn('attachOtelTracer: failed to emit span');
      } catch {
        // logger not initialized — swallow; telemetry must never disrupt the session.
      }
    }
  };

  session.on(AgentSessionEventTypes.MetricsCollected, handler);
  return () => {
    session.off(AgentSessionEventTypes.MetricsCollected, handler);
  };
}

function emitSpan(
  tracer: Tracer,
  spanNames: Record<OtelSpanVariant, string>,
  m: AgentMetrics,
): void {
  switch (m.type) {
    case 'llm_metrics': {
      const startTime = Math.max(0, m.timestamp - m.durationMs);
      const span = tracer.startSpan(spanNames.llm, {
        startTime,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
          ...(m.metadata?.modelProvider && {
            [ATTR_GEN_AI_PROVIDER_NAME]: m.metadata.modelProvider,
          }),
          ...(m.metadata?.modelName && {
            [ATTR_GEN_AI_REQUEST_MODEL]: m.metadata.modelName,
          }),
          [GEN_AI_RESPONSE_ID]: m.requestId,
          [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: m.promptTokens,
          [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: m.completionTokens,
          'lk.gen_ai.ttft_ms': m.ttftMs,
          'lk.gen_ai.tokens_per_second': m.tokensPerSecond,
          'lk.gen_ai.prompt_cached_tokens': m.promptCachedTokens,
          ...(m.speechId && { [ATTR_SPEECH_ID]: m.speechId }),
          [ATTR_LLM_METRICS]: JSON.stringify(m),
        },
      });
      if (m.cancelled) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'cancelled' });
      }
      span.end(m.timestamp);
      return;
    }
    case 'stt_metrics': {
      const startTime = Math.max(0, m.timestamp - m.durationMs);
      const span = tracer.startSpan(spanNames.stt, {
        startTime,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: 'transcribe',
          ...(m.metadata?.modelProvider && {
            [ATTR_GEN_AI_PROVIDER_NAME]: m.metadata.modelProvider,
          }),
          ...(m.metadata?.modelName && {
            [ATTR_GEN_AI_REQUEST_MODEL]: m.metadata.modelName,
          }),
          [GEN_AI_RESPONSE_ID]: m.requestId,
          ...(m.inputTokens !== undefined && {
            [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: m.inputTokens,
          }),
          ...(m.outputTokens !== undefined && {
            [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: m.outputTokens,
          }),
          'lk.stt.audio_duration_ms': m.audioDurationMs,
          'lk.stt.streamed': m.streamed,
        },
      });
      span.end(m.timestamp);
      return;
    }
    case 'tts_metrics': {
      const startTime = Math.max(0, m.timestamp - m.durationMs);
      const span = tracer.startSpan(spanNames.tts, {
        startTime,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: 'synthesize',
          ...(m.metadata?.modelProvider && {
            [ATTR_GEN_AI_PROVIDER_NAME]: m.metadata.modelProvider,
          }),
          ...(m.metadata?.modelName && {
            [ATTR_GEN_AI_REQUEST_MODEL]: m.metadata.modelName,
          }),
          [GEN_AI_RESPONSE_ID]: m.requestId,
          ...(m.inputTokens !== undefined && {
            [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: m.inputTokens,
          }),
          ...(m.outputTokens !== undefined && {
            [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: m.outputTokens,
          }),
          'lk.tts.ttfb_ms': m.ttfbMs,
          'lk.tts.audio_duration_ms': m.audioDurationMs,
          'lk.tts.characters_count': m.charactersCount,
          'lk.tts.streamed': m.streamed,
          ...(m.speechId && { [ATTR_SPEECH_ID]: m.speechId }),
          [ATTR_TTS_METRICS]: JSON.stringify(m),
        },
      });
      if (m.cancelled) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'cancelled' });
      }
      span.end(m.timestamp);
      return;
    }
    case 'realtime_model_metrics': {
      const startTime = Math.max(0, m.timestamp - m.durationMs);
      const span = tracer.startSpan(spanNames.realtime, {
        startTime,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
          ...(m.metadata?.modelProvider && {
            [ATTR_GEN_AI_PROVIDER_NAME]: m.metadata.modelProvider,
          }),
          ...(m.metadata?.modelName && {
            [ATTR_GEN_AI_REQUEST_MODEL]: m.metadata.modelName,
          }),
          [GEN_AI_RESPONSE_ID]: m.requestId,
          [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: m.inputTokens,
          [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: m.outputTokens,
          'lk.realtime.ttft_ms': m.ttftMs,
          'lk.realtime.tokens_per_second': m.tokensPerSecond,
          ...(m.sessionDurationMs !== undefined && {
            'lk.realtime.session_duration_ms': m.sessionDurationMs,
          }),
          'lk.realtime.input_audio_tokens': m.inputTokenDetails.audioTokens,
          'lk.realtime.input_text_tokens': m.inputTokenDetails.textTokens,
          'lk.realtime.input_cached_tokens': m.inputTokenDetails.cachedTokens,
          'lk.realtime.output_audio_tokens': m.outputTokenDetails.audioTokens,
          'lk.realtime.output_text_tokens': m.outputTokenDetails.textTokens,
          [ATTR_REALTIME_MODEL_METRICS]: JSON.stringify(m),
        },
      });
      if (m.cancelled) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'cancelled' });
      }
      span.end(m.timestamp);
      return;
    }
    case 'eou_metrics': {
      const span = tracer.startSpan(spanNames.eou, {
        startTime: m.timestamp,
        attributes: {
          'lk.eou.end_of_utterance_delay_ms': m.endOfUtteranceDelayMs,
          'lk.eou.transcription_delay_ms': m.transcriptionDelayMs,
          'lk.eou.on_user_turn_completed_delay_ms': m.onUserTurnCompletedDelayMs,
          'lk.eou.last_speaking_time_ms': m.lastSpeakingTimeMs,
          ...(m.speechId && { [ATTR_SPEECH_ID]: m.speechId }),
        },
      });
      span.end(m.timestamp);
      return;
    }
    case 'interruption_metrics': {
      const span = tracer.startSpan(spanNames.interruption, {
        startTime: m.timestamp,
        attributes: {
          'lk.interruption.total_duration_ms': m.totalDuration,
          'lk.interruption.prediction_duration_ms': m.predictionDuration,
          'lk.interruption.detection_delay_ms': m.detectionDelay,
          'lk.interruption.num_interruptions': m.numInterruptions,
          'lk.interruption.num_backchannels': m.numBackchannels,
          'lk.interruption.num_requests': m.numRequests,
        },
      });
      span.end(m.timestamp);
      return;
    }
    case 'vad_metrics': {
      const span = tracer.startSpan(spanNames.vad, {
        startTime: m.timestamp,
        attributes: {
          'lk.vad.idle_time_ms': m.idleTimeMs,
          'lk.vad.inference_duration_total_ms': m.inferenceDurationTotalMs,
          'lk.vad.inference_count': m.inferenceCount,
        },
      });
      span.end(m.timestamp);
      return;
    }
  }
}
