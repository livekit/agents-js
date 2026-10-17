// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Supported SmallestAI STT models.
 * @public
 */
export type STTModels = 'pulse' | 'pulse-pro';

/**
 * Supported SmallestAI STT encodings.
 * @public
 */
export type STTEncoding = 'linear16' | 'mulaw' | 'alaw';

/**
 * Supported SmallestAI TTS models.
 * @public
 */
export type TTSModels = 'lightning_v3.1' | 'lightning_v3.1_pro';

/**
 * Supported SmallestAI TTS output formats.
 * @public
 */
export type TTSEncoding = 'pcm' | 'mp3' | 'wav' | 'ulaw' | 'alaw';
