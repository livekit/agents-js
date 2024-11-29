// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  AgentMetrics,
  LLMMetrics,
  PipelineEOUMetrics,
  TTSMetrics,
  VADMetrics,
} from './base.js';

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
    } else if (!isVADMetrics(metrics) && !isPipelineEOUMetrics(metrics)) {
      // has to be STT
      this.#summary.sttAudioDuration += metrics.audioDuration;
    }
  }

  get summary(): UsageSummary {
    return { ...this.#summary };
  }
}

const isLLMMetrics = (metrics: AgentMetrics): metrics is LLMMetrics => {
  return !!(metrics as LLMMetrics).ttft;
};

const isVADMetrics = (metrics: AgentMetrics): metrics is VADMetrics => {
  return !!(metrics as VADMetrics).inferenceCount;
};

const isPipelineEOUMetrics = (metrics: AgentMetrics): metrics is PipelineEOUMetrics => {
  return !!(metrics as PipelineEOUMetrics).endOfUtteranceDelay;
};

const isTTSMetrics = (metrics: AgentMetrics): metrics is TTSMetrics => {
  return !!(metrics as TTSMetrics).ttfb;
};
