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
        ttftMs: roundTwoDecimals(metrics.ttftMs),
        inputTokens: metrics.promptTokens,
        promptCachedTokens: metrics.promptCachedTokens,
        outputTokens: metrics.completionTokens,
        tokensPerSecond: roundTwoDecimals(metrics.tokensPerSecond),
      })
      .info('LLM metrics');
  } else if (metrics.type === 'realtime_model_metrics') {
    logger
      .child({
        ttftMs: roundTwoDecimals(metrics.ttftMs),
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
        ttfbMs: roundTwoDecimals(metrics.ttfbMs),
        audioDurationMs: Math.round(metrics.audioDurationMs),
      })
      .info('TTS metrics');
  } else if (metrics.type === 'eou_metrics') {
    logger
      .child({
        endOfUtteranceDelayMs: roundTwoDecimals(metrics.endOfUtteranceDelayMs),
        transcriptionDelayMs: roundTwoDecimals(metrics.transcriptionDelayMs),
        onUserTurnCompletedDelayMs: roundTwoDecimals(metrics.onUserTurnCompletedDelayMs),
      })
      .info('EOU metrics');
  } else if (metrics.type === 'vad_metrics') {
    logger
      .child({
        idleTimeMs: Math.round(metrics.idleTimeMs),
        inferenceDurationTotalMs: Math.round(metrics.inferenceDurationTotalMs),
        inferenceCount: metrics.inferenceCount,
      })
      .info('VAD metrics');
  } else if (metrics.type === 'stt_metrics') {
    logger
      .child({
        audioDurationMs: Math.round(metrics.audioDurationMs),
      })
      .info('STT metrics');
  }
};
