// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AgentMetrics } from './base.js';

export interface UsageSummary {
  llmPromptTokens: number;
  llmPromptCachedTokens: number;
  llmCompletionTokens: number;
  ttsCharactersCount: number;
  sttAudioDurationMs: number;
}

export class UsageCollector {
  private summary: UsageSummary;

  constructor() {
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
