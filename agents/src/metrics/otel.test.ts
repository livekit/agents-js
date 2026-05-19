// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '../voice/agent_session.js';
import { createMetricsCollectedEvent } from '../voice/events.js';
import type {
  EOUMetrics,
  InterruptionMetrics,
  LLMMetrics,
  RealtimeModelMetrics,
  STTMetrics,
  TTSMetrics,
  VADMetrics,
} from './base.js';
import { attachOtelTracer } from './otel.js';

/** Build a minimal fake session that quacks like an EventEmitter. */
function makeFakeSession(): AgentSession {
  const emitter = new EventEmitter();
  return emitter as unknown as AgentSession;
}

function emit(
  session: AgentSession,
  metrics: Parameters<typeof createMetricsCollectedEvent>[0]['metrics'],
) {
  (session as unknown as EventEmitter).emit(
    'metrics_collected',
    createMetricsCollectedEvent({ metrics }),
  );
}

describe('attachOtelTracer', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    otelContext.disable();
    trace.disable();
  });

  it('emits gen_ai.chat span for llm_metrics with all gen_ai attributes', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const metrics: LLMMetrics = {
      type: 'llm_metrics',
      label: 'openai.LLM',
      requestId: 'req-llm-1',
      timestamp: Date.now(),
      durationMs: 250,
      ttftMs: 80,
      cancelled: false,
      completionTokens: 42,
      promptTokens: 100,
      promptCachedTokens: 10,
      totalTokens: 142,
      tokensPerSecond: 168,
      speechId: 'speech-1',
      metadata: { modelProvider: 'openai', modelName: 'gpt-4o-mini' },
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span).toBeDefined();
    expect(span!.name).toBe('gen_ai.chat');
    expect(span!.attributes['gen_ai.operation.name']).toBe('chat');
    expect(span!.attributes['gen_ai.provider.name']).toBe('openai');
    expect(span!.attributes['gen_ai.request.model']).toBe('gpt-4o-mini');
    expect(span!.attributes['gen_ai.response.id']).toBe('req-llm-1');
    expect(span!.attributes['gen_ai.usage.input_tokens']).toBe(100);
    expect(span!.attributes['gen_ai.usage.output_tokens']).toBe(42);
    expect(span!.attributes['lk.speech_id']).toBe('speech-1');
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('emits gen_ai.transcribe span for stt_metrics with all gen_ai attributes', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const metrics: STTMetrics = {
      type: 'stt_metrics',
      label: 'deepgram.STT',
      requestId: 'req-stt-1',
      timestamp: Date.now(),
      durationMs: 120,
      audioDurationMs: 4500,
      inputTokens: 30,
      outputTokens: 12,
      streamed: true,
      metadata: { modelProvider: 'deepgram', modelName: 'nova-2' },
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('gen_ai.transcribe');
    expect(span!.attributes['gen_ai.operation.name']).toBe('transcribe');
    expect(span!.attributes['gen_ai.provider.name']).toBe('deepgram');
    expect(span!.attributes['gen_ai.request.model']).toBe('nova-2');
    expect(span!.attributes['gen_ai.response.id']).toBe('req-stt-1');
    expect(span!.attributes['gen_ai.usage.input_tokens']).toBe(30);
    expect(span!.attributes['gen_ai.usage.output_tokens']).toBe(12);
  });

  it('emits gen_ai.synthesize span for tts_metrics with all gen_ai attributes', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const metrics: TTSMetrics = {
      type: 'tts_metrics',
      label: 'elevenlabs.TTS',
      requestId: 'req-tts-1',
      timestamp: Date.now(),
      ttfbMs: 60,
      durationMs: 320,
      audioDurationMs: 2800,
      cancelled: false,
      charactersCount: 145,
      streamed: false,
      speechId: 'speech-2',
      metadata: { modelProvider: 'elevenlabs', modelName: 'eleven_turbo_v2' },
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('gen_ai.synthesize');
    expect(span!.attributes['gen_ai.operation.name']).toBe('synthesize');
    expect(span!.attributes['gen_ai.provider.name']).toBe('elevenlabs');
    expect(span!.attributes['gen_ai.request.model']).toBe('eleven_turbo_v2');
    expect(span!.attributes['lk.speech_id']).toBe('speech-2');
  });

  it('emits gen_ai.realtime span for realtime_model_metrics', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const metrics: RealtimeModelMetrics = {
      type: 'realtime_model_metrics',
      label: 'openai.Realtime',
      requestId: 'req-rt-1',
      timestamp: Date.now(),
      durationMs: 800,
      ttftMs: 120,
      cancelled: false,
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
      tokensPerSecond: 100,
      inputTokenDetails: { audioTokens: 150, textTokens: 50, imageTokens: 0, cachedTokens: 20 },
      outputTokenDetails: { textTokens: 30, audioTokens: 50, imageTokens: 0 },
      metadata: { modelProvider: 'openai', modelName: 'gpt-4o-realtime' },
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('gen_ai.realtime');
    expect(span!.attributes['gen_ai.provider.name']).toBe('openai');
    expect(span!.attributes['gen_ai.request.model']).toBe('gpt-4o-realtime');
    expect(span!.attributes['gen_ai.usage.input_tokens']).toBe(200);
    expect(span!.attributes['gen_ai.usage.output_tokens']).toBe(80);
  });

  it('emits lk.eou span for eou_metrics', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const metrics: EOUMetrics = {
      type: 'eou_metrics',
      timestamp: Date.now(),
      endOfUtteranceDelayMs: 180,
      transcriptionDelayMs: 90,
      onUserTurnCompletedDelayMs: 12,
      lastSpeakingTimeMs: Date.now() - 200,
      speechId: 'speech-3',
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('lk.eou');
    expect(span!.attributes['lk.eou.end_of_utterance_delay_ms']).toBe(180);
    expect(span!.attributes['lk.eou.transcription_delay_ms']).toBe(90);
    expect(span!.attributes['lk.speech_id']).toBe('speech-3');
  });

  it('emits lk.interruption span for interruption_metrics', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const metrics: InterruptionMetrics = {
      type: 'interruption_metrics',
      timestamp: Date.now(),
      totalDuration: 45,
      predictionDuration: 30,
      detectionDelay: 12,
      numInterruptions: 2,
      numBackchannels: 1,
      numRequests: 5,
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('lk.interruption');
    expect(span!.attributes['lk.interruption.total_duration_ms']).toBe(45);
    expect(span!.attributes['lk.interruption.num_interruptions']).toBe(2);
  });

  it('emits lk.vad span for vad_metrics', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const metrics: VADMetrics = {
      type: 'vad_metrics',
      label: 'silero',
      timestamp: Date.now(),
      idleTimeMs: 1000,
      inferenceDurationTotalMs: 50,
      inferenceCount: 25,
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('lk.vad');
    expect(span!.attributes['lk.vad.idle_time_ms']).toBe(1000);
    expect(span!.attributes['lk.vad.inference_count']).toBe(25);
  });

  it('marks span status ERROR when cancelled is true', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const metrics: LLMMetrics = {
      type: 'llm_metrics',
      label: 'openai.LLM',
      requestId: 'req-cancel',
      timestamp: Date.now(),
      durationMs: 50,
      ttftMs: 0,
      cancelled: true,
      completionTokens: 0,
      promptTokens: 10,
      promptCachedTokens: 0,
      totalTokens: 10,
      tokensPerSecond: 0,
      metadata: { modelProvider: 'openai', modelName: 'gpt-4o-mini' },
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('emits independent spans for multiple metrics in sequence', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const base = {
      timestamp: Date.now(),
      durationMs: 100,
      ttftMs: 50,
      cancelled: false,
      completionTokens: 1,
      promptTokens: 1,
      promptCachedTokens: 0,
      totalTokens: 2,
      tokensPerSecond: 10,
    } as const;
    emit(session, { ...base, type: 'llm_metrics', label: 'llm', requestId: 'a' });
    emit(session, { ...base, type: 'llm_metrics', label: 'llm', requestId: 'b' });
    emit(session, { ...base, type: 'llm_metrics', label: 'llm', requestId: 'c' });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    const ids = spans.map((s) => s.attributes['gen_ai.response.id']);
    expect(ids).toEqual(['a', 'b', 'c']);
    const spanIds = new Set(spans.map((s) => s.spanContext().spanId));
    expect(spanIds.size).toBe(3); // each span has a unique span id
  });

  it('unsubscribe stops emitting spans', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    const unsubscribe = attachOtelTracer(session, tracer);

    const metrics: LLMMetrics = {
      type: 'llm_metrics',
      label: 'openai.LLM',
      requestId: 'req-1',
      timestamp: Date.now(),
      durationMs: 100,
      ttftMs: 50,
      cancelled: false,
      completionTokens: 1,
      promptTokens: 1,
      promptCachedTokens: 0,
      totalTokens: 2,
      tokensPerSecond: 10,
    };
    emit(session, metrics);
    expect(exporter.getFinishedSpans()).toHaveLength(1);

    unsubscribe();
    emit(session, { ...metrics, requestId: 'req-2' });
    expect(exporter.getFinishedSpans()).toHaveLength(1); // no new span
  });

  it('does not propagate when tracer.startSpan throws', () => {
    const session = makeFakeSession();
    const brokenTracer = {
      startSpan: () => {
        throw new Error('tracer is broken');
      },
    } as unknown as Parameters<typeof attachOtelTracer>[1];

    attachOtelTracer(session, brokenTracer);

    const metrics: LLMMetrics = {
      type: 'llm_metrics',
      label: 'openai.LLM',
      requestId: 'req-throw',
      timestamp: Date.now(),
      durationMs: 100,
      ttftMs: 50,
      cancelled: false,
      completionTokens: 1,
      promptTokens: 1,
      promptCachedTokens: 0,
      totalTokens: 2,
      tokensPerSecond: 10,
    };
    // Must not throw — telemetry failure should never disrupt the session.
    expect(() => emit(session, metrics)).not.toThrow();
  });

  it('omits gen_ai.* attrs when metadata is missing', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer);

    const metrics: LLMMetrics = {
      type: 'llm_metrics',
      label: 'unknown.LLM',
      requestId: 'req-no-meta',
      timestamp: Date.now(),
      durationMs: 100,
      ttftMs: 50,
      cancelled: false,
      completionTokens: 1,
      promptTokens: 1,
      promptCachedTokens: 0,
      totalTokens: 2,
      tokensPerSecond: 10,
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['gen_ai.operation.name']).toBe('chat');
    expect(span!.attributes['gen_ai.provider.name']).toBeUndefined();
    expect(span!.attributes['gen_ai.request.model']).toBeUndefined();
    expect(span!.attributes['gen_ai.response.id']).toBe('req-no-meta');
  });

  it('respects custom spanNames override', () => {
    const session = makeFakeSession();
    const tracer = provider.getTracer('test');
    attachOtelTracer(session, tracer, { spanNames: { llm: 'my.custom.llm' } });

    const metrics: LLMMetrics = {
      type: 'llm_metrics',
      label: 'openai.LLM',
      requestId: 'req-custom',
      timestamp: Date.now(),
      durationMs: 100,
      ttftMs: 50,
      cancelled: false,
      completionTokens: 1,
      promptTokens: 1,
      promptCachedTokens: 0,
      totalTokens: 2,
      tokensPerSecond: 10,
    };
    emit(session, metrics);

    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('my.custom.llm');
  });
});
