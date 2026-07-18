// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Type definitions for Blaze AI models and options.
 */

/** Available TTS realtime model identifiers (gateway aliases). */
export type BlazeTTSModel =
  | '2.0-realtime'
  | '1.5-realtime'
  | '2.0-beta'
  | '2.5-beta'
  | '2.0-vllm'
  | string; // Allow custom model names

/** Available STT model identifiers. */
export type BlazeSTTModel =
  | 'stt-async-1.5'
  | 'stt-async-1.0'
  | 'stt-stream-1.5'
  | 'v1.0'
  | 'v2.0'
  | string;

/** Default batch STT model (POST /v1/stt/transcribe). */
export const DEFAULT_STT_BATCH_MODEL: BlazeSTTModel = 'stt-async-1.5';

/** Default realtime STT model (WS /v1/stt/realtime). */
export const DEFAULT_STT_STREAM_MODEL: BlazeSTTModel = 'stt-stream-1.5';

/** Default realtime TTS model (WS/HTTP /v1/tts/realtime). */
export const DEFAULT_TTS_MODEL: BlazeTTSModel = '2.0-realtime';

/** Supported language codes. */
export type BlazeLanguage =
  | 'vi' // Vietnamese (default)
  | 'en' // English
  | 'zh' // Chinese
  | 'ja' // Japanese
  | 'ko' // Korean
  | string; // Allow any IETF language tag

/** Audio format supported by the Blaze TTS plugin output pipeline. */
export type BlazeAudioFormat = 'pcm';

/** Gender values for demographics. */
export type BlazeGender = 'male' | 'female' | 'unknown';

/** User demographics for personalization. */
export interface BlazeDemographics {
  gender?: BlazeGender;
  age?: number;
}

/** Blaze STT API response. */
export interface BlazeSTTResponse {
  transcription: string;
  confidence: number;
  is_final?: boolean;
  language?: string;
}

/** Blaze chatbot message format. */
export interface BlazeChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Blaze LLM SSE data formats. */
export type BlazeLLMData =
  | { content: string } // Format 1: primary
  | { text: string } // Format 2: fallback
  | { delta: { text: string } }; // Format 3: delta
