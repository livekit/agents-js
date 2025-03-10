// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import type {
  AgentMetrics,
  LLMMetrics,
  PipelineEOUMetrics,
  PipelineLLMMetrics,
  PipelineTTSMetrics,
  STTMetrics,
  TTSMetrics,
  VADMetrics,
} from './base.js';

export const logMetrics = (metrics: AgentMetrics) => {
  const logger = log();
  if (isPipelineLLMMetrics(metrics)) {
    logger
      .child({
        sequenceId: metrics.sequenceId,
        ttft: metrics.ttft,
        inputTokens: metrics.promptTokens,
        outputTokens: metrics.completionTokens,
        tokensPerSecond: metrics.tokensPerSecond,
      })
      .info('Pipeline LLM metrics');
  } else if (isLLMMetrics(metrics)) {
    logger
      .child({
        ttft: metrics.ttft,
        inputTokens: metrics.promptTokens,
        outputTokens: metrics.completionTokens,
        tokensPerSecond: metrics.tokensPerSecond,
      })
      .info('LLM metrics');
  } else if (isPipelineTTSMetrics(metrics)) {
    logger
      .child({
        sequenceId: metrics.sequenceId,
        ttfb: metrics.ttfb,
        audioDuration: metrics.audioDuration,
      })
      .info('Pipeline TTS metrics');
  } else if (isTTSMetrics(metrics)) {
    logger
      .child({
        ttfb: metrics.ttfb,
        audioDuration: metrics.audioDuration,
      })
      .info('TTS metrics');
  } else if (isPipelineEOUMetrics(metrics)) {
    logger
      .child({
        sequenceId: metrics.sequenceId,
        endOfUtteranceDelay: metrics.endOfUtteranceDelay,
        transcriptionDelay: metrics.transcriptionDelay,
      })
      .info('Pipeline EOU metrics');
  } else if (isSTTMetrics(metrics)) {
    logger
      .child({
        audioDuration: metrics.audioDuration,
      })
      .info('STT metrics');
  }
};

export const isLLMMetrics = (metrics: AgentMetrics): metrics is LLMMetrics => {
  return !!(metrics as LLMMetrics).ttft;
};

export const isPipelineLLMMetrics = (metrics: AgentMetrics): metrics is PipelineLLMMetrics => {
  return isLLMMetrics(metrics) && !!(metrics as PipelineLLMMetrics).sequenceId;
};

export const isVADMetrics = (metrics: AgentMetrics): metrics is VADMetrics => {
  return !!(metrics as VADMetrics).inferenceCount;
};

export const isPipelineEOUMetrics = (metrics: AgentMetrics): metrics is PipelineEOUMetrics => {
  return !!(metrics as PipelineEOUMetrics).endOfUtteranceDelay;
};

export const isTTSMetrics = (metrics: AgentMetrics): metrics is TTSMetrics => {
  return !!(metrics as TTSMetrics).ttfb;
};

export const isPipelineTTSMetrics = (metrics: AgentMetrics): metrics is PipelineTTSMetrics => {
  return isTTSMetrics(metrics) && !!(metrics as PipelineTTSMetrics).sequenceId;
};

export const isSTTMetrics = (metrics: AgentMetrics): metrics is STTMetrics => {
  return !(
    isLLMMetrics(metrics) ||
    isVADMetrics(metrics) ||
    isPipelineEOUMetrics(metrics) ||
    isTTSMetrics(metrics)
  );
};
