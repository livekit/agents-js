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
  /** Duration of the request in milliseconds. */
  durationMs: number;
  /** Time to first token in milliseconds. */
  ttftMs: number;
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
   * The request duration in milliseconds, 0.0 if the STT is streaming.
   */
  durationMs: number;
  /**
   * The duration of the pushed audio in milliseconds.
   */
  audioDurationMs: number;
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
  /** Time to first byte in milliseconds. */
  ttfbMs: number;
  /** Total synthesis duration in milliseconds. */
  durationMs: number;
  /** Generated audio duration in milliseconds. */
  audioDurationMs: number;
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
  idleTimeMs: number;
  inferenceDurationTotalMs: number;
  inferenceCount: number;
};

export type EOUMetrics = {
  type: 'eou_metrics';
  timestamp: number;
  /**
   * Amount of time between the end of speech from VAD and the decision to end the user's turn.
   * Set to 0.0 if the end of speech was not detected.
   */
  endOfUtteranceDelayMs: number;
  /**
   * Time taken to obtain the transcript after the end of the user's speech.
   * Set to 0.0 if the end of speech was not detected.
   */
  transcriptionDelayMs: number;
  /**
   * Time taken to invoke the user's `Agent.onUserTurnCompleted` callback.
   */
  onUserTurnCompletedDelayMs: number;
  /**
   * The time the user stopped speaking.
   */
  lastSpeakingTimeMs: number;
  /**
   * The ID of the speech handle.
   */
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
   * The duration of the response from created to done in milliseconds.
   */
  durationMs: number;
  /**
   * Time to first audio token in milliseconds. -1 if no audio token was sent.
   */
  ttftMs: number;
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
