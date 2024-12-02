// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AgentMetrics } from './base.js';
import { isLLMMetrics, isSTTMetrics, isTTSMetrics } from './utils.js';

export interface UsageSummary {
  llmPromptTokens: number;
  llmCompletionTokens: number;
  ttsCharactersCount: number;
  sttAudioDuration: number;
}

export class UsageCollector {
  #summary: UsageSummary;

  constructor() {
    this.#summary = {
      llmPromptTokens: 0,
      llmCompletionTokens: 0,
      ttsCharactersCount: 0,
      sttAudioDuration: 0,
    };
  }

  collect(metrics: AgentMetrics) {
    if (isLLMMetrics(metrics)) {
      this.#summary.llmPromptTokens += metrics.promptTokens;
      this.#summary.llmCompletionTokens += metrics.completionTokens;
    } else if (isTTSMetrics(metrics)) {
      this.#summary.ttsCharactersCount += metrics.charactersCount;
    } else if (isSTTMetrics(metrics)) {
      this.#summary.sttAudioDuration += metrics.audioDuration;
    }
  }

  get summary(): UsageSummary {
    return { ...this.#summary };
  }
}
