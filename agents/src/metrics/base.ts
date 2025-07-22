// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type AgentMetrics =
  | STTMetrics
  | LLMMetrics
  | TTSMetrics
  | VADMetrics
  | EOUMetrics
  | RealtimeModelMetrics;

export type LLMMetrics = {
  type: 'llm_metrics';
  label: string;
  requestId: string;
  timestamp: number;
  duration: number;
  ttft: number;
  cancelled: boolean;
  completionTokens: number;
  promptTokens: number;
  promptCachedTokens: number;
  totalTokens: number;
  tokensPerSecond: number;
  speechId?: string;
};

export type STTMetrics = {
  type: 'stt_metrics';
  label: string;
  requestId: string;
  timestamp: number;
  /**
   * The request duration in seconds, 0.0 if the STT is streaming.
   */
  duration: number;
  /**
   * The duration of the pushed audio in seconds.
   */
  audioDuration: number;
  /**
   * Whether the STT is streaming (e.g using websocket).
   */
  streamed: boolean;
};

export type TTSMetrics = {
  type: 'tts_metrics';
  label: string;
  requestId: string;
  timestamp: number;
  ttfb: number;
  duration: number;
  audioDuration: number;
  cancelled: boolean;
  charactersCount: number;
  streamed: boolean;
  segmentId?: string;
  speechId?: string;
};

export type VADMetrics = {
  type: 'vad_metrics';
  label: string;
  timestamp: number;
  idleTime: number;
  inferenceDurationTotal: number;
  inferenceCount: number;
};

export type EOUMetrics = {
  type: 'eou_metrics';
  timestamp: number;
  /**
   * Amount of time between the end of speech from VAD and the decision to end the user's turn.
   * Set to 0.0 if the end of speech was not detected.
   */
  endOfUtteranceDelay: number;
  /**
   * Time taken to obtain the transcript after the end of the user's speech.
   * Set to 0.0 if the end of speech was not detected.
   */
  transcriptionDelay: number;
  /**
   * Time taken to invoke the user's `Agent.onUserTurnCompleted` callback.
   */
  onUserTurnCompletedDelay: number;
  speechId?: string;
};

export type RealtimeModelMetricsCachedTokenDetails = {
  audioTokens: number;
  textTokens: number;
  imageTokens: number;
};

export type RealtimeModelMetricsInputTokenDetails = {
  audioTokens: number;
  textTokens: number;
  imageTokens: number;
  cachedTokens: number;
  cachedTokensDetails?: RealtimeModelMetricsCachedTokenDetails;
};

export type RealtimeModelMetricsOutputTokenDetails = {
  textTokens: number;
  audioTokens: number;
  imageTokens: number;
};

export type RealtimeModelMetrics = {
  type: 'realtime_model_metrics';
  label: string;
  requestId: string;
  /**
   * The timestamp of the response creation.
   */
  timestamp: number;
  /**
   * The duration of the response from created to done in seconds.
   */
  duration: number;
  /**
   * Time to first audio token in seconds. -1 if no audio token was sent.
   */
  ttft: number;
  /**
   * Whether the request was cancelled.
   */
  cancelled: boolean;
  /**
   * The number of input tokens used in the Response, including text and audio tokens.
   */
  inputTokens: number;
  /**
   * The number of output tokens sent in the Response, including text and audio tokens.
   */
  outputTokens: number;
  /**
   * The total number of tokens in the Response.
   */
  totalTokens: number;
  /**
   * The number of tokens per second.
   */
  tokensPerSecond: number;
  /**
   * Details about the input tokens used in the Response.
   */
  inputTokenDetails: RealtimeModelMetricsInputTokenDetails;
  /**
   * Details about the output tokens used in the Response.
   */
  outputTokenDetails: RealtimeModelMetricsOutputTokenDetails;
};
