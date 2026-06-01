// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * LiveKit uses this encoding for all audio
 */
export const AUDIO_ENCODING = 'pcm_s16le';

// ============================================================================
//                                   TTS
// ============================================================================

/**
 * See [the docs](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest) for all options.
 */
export type TTSModels =
  | 'sonic'
  | 'sonic-2'
  | 'sonic-3'
  | 'sonic-lite'
  | 'sonic-preview'
  | 'sonic-turbo';

/**
 * See [the docs](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest) for all options.
 */
export type TTSLanguages = 'en' | 'es' | 'fr' | 'de' | 'pt' | 'zh' | 'ja';

export const TTSDefaultVoiceId = 'f786b574-daa5-4673-aa0c-cbe3e8534c02';

export const isSonic3 = (model: string): boolean => model.startsWith('sonic-3');

export type TTSVoiceSpeed = 'fastest' | 'fast' | 'normal' | 'slow' | 'slowest';

export type TTSVoiceEmotion =
  | 'anger:lowest'
  | 'anger:low'
  | 'anger'
  | 'anger:high'
  | 'anger:highest'
  | 'positivity:lowest'
  | 'positivity:low'
  | 'positivity'
  | 'positivity:high'
  | 'positivity:highest'
  | 'surprise:lowest'
  | 'surprise:low'
  | 'surprise'
  | 'surprise:high'
  | 'surprise:highest'
  | 'sadness:lowest'
  | 'sadness:low'
  | 'sadness'
  | 'sadness:high'
  | 'sadness:highest'
  | 'curiosity:lowest'
  | 'curiosity:low'
  | 'curiosity'
  | 'curiosity:high'
  | 'curiosity:highest';

/**
 * @deprecated Encoding should not be parameterized. Only `pcm_s16le`is allowed. Prefer using {@link AUDIO_ENCODING}.
 */
export type TTSEncoding = 'pcm_s16le';

// ============================================================================
//                                   STT
// ============================================================================

/**
 * See [the docs](https://docs.cartesia.ai/build-with-cartesia/stt-models/latest) for all options.
 */
export type STTModel = 'ink-2';
