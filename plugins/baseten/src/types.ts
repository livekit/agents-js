// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Baseten plugin types and interfaces
 */

/**
 * Options for configuring the Baseten LLM
 * Since Baseten provides an OpenAI-compatible API, these options
 * map to standard OpenAI parameters.
 */
export interface BasetenLLMOptions {
  apiKey?: string;
  model: string;
  temperature?: number;
  /** Nucleus sampling parameter. Forwarded to Baseten as `top_p`. */
  topP?: number;
  maxTokens?: number;
  /**
   * Penalty for new tokens based on whether they appear in the text so far.
   * Forwarded to Baseten as `presence_penalty`.
   */
  presencePenalty?: number;
  /**
   * Penalty for new tokens based on their frequency in the text so far.
   * Forwarded to Baseten as `frequency_penalty`.
   */
  frequencyPenalty?: number;
  user?: string;
  toolChoice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  parallelToolCalls?: boolean;
}

/**
 * Options for configuring the Baseten STT service
 */
export interface BasetenSttOptions {
  apiKey: string;
  /** @deprecated Use modelEndpoint instead */
  modelId?: string;
  /** Full WebSocket endpoint URL (e.g., from Baseten dashboard). Takes priority over modelId. */
  modelEndpoint?: string;
  environment?: string;
  encoding?: string;
  sampleRate?: number;
  bufferSizeSeconds?: number;
  vadThreshold?: number;
  vadMinSilenceDurationMs?: number;
  vadSpeechPadMs?: number;
  enablePartialTranscripts?: boolean;
  partialTranscriptIntervalS?: number;
  finalTranscriptMaxDurationS?: number;
  audioLanguage?: string;
  prompt?: string;
  languageDetectionOnly?: boolean;
}

/**
 * Options for configuring the Baseten TTS service
 */
export interface BasetenTTSOptions {
  apiKey: string;
  modelEndpoint: string;
  voice?: string;
  language?: string;
  temperature?: number;
  maxTokens?: number;
}
