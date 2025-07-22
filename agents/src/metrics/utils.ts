// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import type { AgentMetrics } from './base.js';

function roundTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

export const logMetrics = (metrics: AgentMetrics) => {
  const logger = log();
  if (metrics.type === 'llm_metrics') {
    logger
      .child({
        ttft: roundTwoDecimals(metrics.ttft),
        inputTokens: metrics.promptTokens,
        promptCachedTokens: metrics.promptCachedTokens,
        outputTokens: metrics.completionTokens,
        tokensPerSecond: roundTwoDecimals(metrics.tokensPerSecond),
      })
      .info('LLM metrics');
  } else if (metrics.type === 'realtime_model_metrics') {
    logger
      .child({
        ttft: roundTwoDecimals(metrics.ttft),
        input_tokens: metrics.inputTokens,
        cached_input_tokens: metrics.inputTokenDetails.cachedTokens,
        output_tokens: metrics.outputTokens,
        total_tokens: metrics.totalTokens,
        tokens_per_second: roundTwoDecimals(metrics.tokensPerSecond),
      })
      .info('RealtimeModel metrics');
  } else if (metrics.type === 'tts_metrics') {
    logger
      .child({
        ttfb: roundTwoDecimals(metrics.ttfb),
        audioDuration: metrics.audioDuration,
      })
      .info('TTS metrics');
  } else if (metrics.type === 'eou_metrics') {
    logger
      .child({
        end_of_utterance_delay: roundTwoDecimals(metrics.endOfUtteranceDelay),
        transcription_delay: roundTwoDecimals(metrics.transcriptionDelay),
      })
      .info('EOU metrics');
  } else if (metrics.type === 'stt_metrics') {
    logger
      .child({
        audioDuration: metrics.audioDuration,
      })
      .info('STT metrics');
  }
};
