// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Type definitions for Blaze AI models and options.
 */

/** Available TTS model identifiers. */
export type BlazeTTSModel = 'v1_5_pro' | 'v2_pro' | string; // Allow custom model names

/** Supported language codes. */
export type BlazeLanguage =
  | 'vi' // Vietnamese (default)
  | 'en' // English
  | 'zh' // Chinese
  | 'ja' // Japanese
  | 'ko' // Korean
  | string; // Allow any IETF language tag

/** Audio format for TTS output. */
export type BlazeAudioFormat = 'pcm' | 'mp3' | 'wav';

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
