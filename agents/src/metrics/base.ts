// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface LLMMetrics {
  requestId: string;
  timestamp: number;
  ttft: number;
  duration: number;
  label: string;
  cancelled: boolean;
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
  tokensPerSecond: number;
  error?: Error;
}

export interface STTMetrics {
  requestId: string;
  timestamp: number;
  duration: number;
  label: string;
  audioDuration: number;
  streamed: boolean;
  error?: Error;
}

export interface TTSMetrics {
  requestId: string;
  timestamp: number;
  ttfb: number;
  duration: number;
  label: string;
  audioDuration: number;
  cancelled: boolean;
  charactersCount: number;
  streamed: boolean;
  error?: Error;
}

export interface VADMetrics {
  timestamp: number;
  idleTime: number;
  inferenceDurationTotal: number;
  inferenceCount: number;
  label: string;
}

export interface PipelineEOUMetrics {
  /**
   * Unique identifier shared across different metrics to combine related STT, LLM, and TTS metrics
   */
  sequenceId: string;
  /** Timestamp of when the event was recorded */
  timestamp: number;
  /** Amount of time between the end of speech from VAD and the decision to end the user's turn */
  endOfUtteranceDelay: number;
  /**
   * Time taken to obtain the transcript after the end of the user's speech.
   *
   * @remarks
   * May be 0 if the transcript was already available.
   */
  transcriptionDelay: number;
}

export interface PipelineLLMMetrics extends LLMMetrics {
  /**
   * Unique identifier shared across different metrics to combine related STT, LLM, and TTS metrics
   */
  sequenceId: string;
}

export interface PipelineTTSMetrics extends TTSMetrics {
  /**
   * Unique identifier shared across different metrics to combine related STT, LLM, and TTS metrics
   */
  sequenceId: string;
}

export type PipelineSTTMetrics = STTMetrics;
export type PipelineVADMetrics = VADMetrics;

export class MultimodalLLMError extends Error {
  type?: string;
  reason?: string;
  code?: string;
  constructor({
    type,
    reason,
    code,
    message,
  }: { type?: string; reason?: string; code?: string; message?: string } = {}) {
    super(message);
    this.type = type;
    this.reason = reason;
    this.code = code;
  }
}

export interface MultimodalLLMMetrics extends LLMMetrics {
  inputTokenDetails: {
    cachedTokens: number;
    textTokens: number;
    audioTokens: number;
  };
  outputTokenDetails: {
    textTokens: number;
    audioTokens: number;
  };
}

export type AgentMetrics =
  | STTMetrics
  | LLMMetrics
  | TTSMetrics
  | VADMetrics
  | PipelineSTTMetrics
  | PipelineEOUMetrics
  | PipelineLLMMetrics
  | PipelineTTSMetrics
  | PipelineVADMetrics
  | MultimodalLLMMetrics;
