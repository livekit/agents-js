// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import * as traceTypes from './trace_types.js';

const PII_SEGMENT_RE = /(^|\.)pii(\.|$)/i;

// Keys that carry no conversational content, tool payloads, or other user data.
const SAFE_KEYS = new Set([
  // Correlation IDs and session metadata
  'lk.speech_id',
  'lk.agent_label',
  'lk.start_time',
  'lk.end_time',
  'lk.retry_count',
  'lk.provider_request_ids',
  'lk.participant_id',
  'lk.participant_identity',
  'lk.participant_kind',
  'lk.job_id',
  'lk.agent_name',
  'lk.room_name',
  'lk.session_options',
  'lk.generation_id',
  'lk.parent_generation_id',
  'lk.interrupted',
  // LLM node metadata
  'lk.function_tools',
  'lk.provider_tools',
  'lk.tool_sets',
  'lk.response.ttft',
  // Function tool metadata
  'lk.function_tool.id',
  'lk.function_tool.name',
  'lk.function_tool.is_error',
  // TTS metadata
  'lk.tts.streaming',
  'lk.tts.label',
  'lk.response.ttfb',
  // EOU detection
  'lk.eou.probability',
  'lk.eou.unlikely_threshold',
  'lk.eou.endpointing_delay',
  'lk.eou.language',
  'lk.eou.source',
  'lk.eou.from_cache',
  'lk.eou.detection_delay',
  'lk.transcript_confidence',
  'lk.transcription_delay',
  'lk.end_of_turn_delay',
  // Metrics
  'lk.llm_metrics',
  'lk.tts_metrics',
  'lk.realtime_model_metrics',
  'lk.e2e_latency',
  // OpenTelemetry GenAI attributes and event names
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.provider.name',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.input_text_tokens',
  'gen_ai.usage.input_audio_tokens',
  'gen_ai.usage.input_cached_tokens',
  'gen_ai.usage.output_text_tokens',
  'gen_ai.usage.output_audio_tokens',
  'gen_ai.system.message',
  'gen_ai.user.message',
  'gen_ai.assistant.message',
  'gen_ai.tool.message',
  'gen_ai.choice',
  // OpenTelemetry exception attributes
  'exception.stacktrace',
  'exception.type',
  'exception.message',
  // Vendor metadata
  'langfuse.observation.completion_start_time',
  // Answering machine detection
  'lk.amd.category',
  'lk.amd.reason',
  'lk.amd.is_machine',
  'lk.amd.interrupt_on_machine',
  'lk.amd.speech_duration',
  'lk.amd.delay',
  // Adaptive interruption
  'lk.is_interruption',
  'lk.interruption.probability',
  'lk.interruption.total_duration',
  'lk.interruption.prediction_duration',
  'lk.interruption.detection_delay',
]);

function declaredKeys(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(traceTypes).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );
}

describe('telemetry key PII classification', () => {
  it('classifies every declared key as safe or PII-bearing', () => {
    const unclassified = Object.fromEntries(
      Object.entries(declaredKeys()).filter(
        ([, value]) => !SAFE_KEYS.has(value) && !PII_SEGMENT_RE.test(value),
      ),
    );

    expect(unclassified).toEqual({});
  });

  it('does not mark safe keys as PII-bearing', () => {
    const conflicting = [...SAFE_KEYS].filter((key) => PII_SEGMENT_RE.test(key)).sort();

    expect(conflicting).toEqual([]);
  });

  it('does not retain stale safe-list entries', () => {
    const declared = new Set(Object.values(declaredKeys()));
    const stale = [...SAFE_KEYS].filter((key) => !declared.has(key)).sort();

    expect(stale).toEqual([]);
  });
});
