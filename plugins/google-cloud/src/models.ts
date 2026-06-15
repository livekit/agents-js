// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Google Cloud TTS models. */
export type TTSModel =
  | 'chirp-3'
  | 'chirp-3-hd'
  | 'journey'
  | 'journey-2'
  | 'chirp-2-hd'
  | 'chirp-2-lq'
  | string;

/** Google Cloud TTS voice genders. */
export type TTSGender = 'male' | 'female' | 'neutral';

/** Speech language codes (BCP-47). */
export type TTSLanguage =
  | 'en-US'
  | 'en-GB'
  | 'en-AU'
  | 'en-IN'
  | 'hi-IN'
  | 'bn-IN'
  | 'ta-IN'
  | 'te-IN'
  | 'mr-IN'
  | 'gu-IN'
  | 'kn-IN'
  | 'ml-IN'
  | 'pa-IN'
  | string;

/** Audio encoding formats for non-streaming synthesis. */
export type TTSAudioEncoding = 'LINEAR16' | 'MP3' | 'OGG_OPUS' | 'MULAW' | 'ALAW';

/** Default voice name used when none is specified. */
export const DEFAULT_VOICE_NAME = 'en-US-Standard-H';
