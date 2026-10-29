// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Respeecher public TTS models.
 * @public
 */
export type TTSModels = '/public/tts/en-rt' | '/public/tts/ua-rt';

/**
 * Respeecher TTS audio encodings.
 * @public
 */
export type TTSEncoding = 'pcm_s16le';

/**
 * Respeecher sampling parameters.
 * @public
 */
export type SamplingParams = Record<string, unknown>;

/**
 * Voice settings for Respeecher TTS.
 * @public
 */
export interface VoiceSettings {
  samplingParams?: SamplingParams;
}

/**
 * Voice model returned by Respeecher.
 * @public
 */
export interface Voice {
  id: string;
  sampling_params?: SamplingParams;
  [key: string]: unknown;
}
