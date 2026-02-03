// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import type { AgentMetrics } from './base.js';

// Ref: python livekit-agents/livekit/agents/metrics/usage_collector.py - lines 10-14 (diff)
// NOTE: Python uses warnings.warn() for deprecation at runtime.
// TypeScript uses JSDoc @deprecated which shows in IDE.
// We also add optional console.warn() in constructor for runtime parity.
/**
 * @deprecated Use LLMModelUsage, TTSModelUsage, or STTModelUsage from './model_usage.js' instead.
 * These new types provide per-model/provider usage aggregation for more detailed tracking.
 * Ref: python livekit-agents/livekit/agents/metrics/usage_collector.py - lines 10-14 (diff)
 */
export interface UsageSummary {
  llmPromptTokens: number;
  llmPromptCachedTokens: number;
  llmCompletionTokens: number;
  ttsCharactersCount: number;
  sttAudioDurationMs: number;
}

/**
 * @deprecated Use ModelUsageCollector from './model_usage.js' instead.
 * ModelUsageCollector provides per-model/provider usage aggregation for more detailed tracking.
 */
export class UsageCollector {
  private summary: UsageSummary;
  private logger = log();

  constructor() {
    this.logger.warn('UsageCollector is deprecated. Use ModelUsageCollector instead.');
    this.summary = {
      llmPromptTokens: 0,
      llmPromptCachedTokens: 0,
      llmCompletionTokens: 0,
      ttsCharactersCount: 0,
      sttAudioDurationMs: 0,
    };
  }

  collect(metrics: AgentMetrics): void {
    if (metrics.type === 'llm_metrics') {
      this.summary.llmPromptTokens += metrics.promptTokens;
      this.summary.llmPromptCachedTokens += metrics.promptCachedTokens;
      this.summary.llmCompletionTokens += metrics.completionTokens;
    } else if (metrics.type === 'realtime_model_metrics') {
      this.summary.llmPromptTokens += metrics.inputTokens;
      this.summary.llmPromptCachedTokens += metrics.inputTokenDetails.cachedTokens;
      this.summary.llmCompletionTokens += metrics.outputTokens;
    } else if (metrics.type === 'tts_metrics') {
      this.summary.ttsCharactersCount += metrics.charactersCount;
    } else if (metrics.type === 'stt_metrics') {
      this.summary.sttAudioDurationMs += metrics.audioDurationMs;
    }
  }

  getSummary(): UsageSummary {
    return { ...this.summary };
  }
}
