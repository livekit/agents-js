// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Supported Gradium TTS models */
export type TTSModels = 'default' | string;

/**
 * Supported audio output formats.
 * - `wav`: 48 kHz, 16-bit signed mono (includes WAV header)
 * - `pcm`: 48 kHz, 16-bit signed little-endian mono, raw
 * - `opus`: Ogg-wrapped Opus
 * - `pcm_8000`–`pcm_48000`: Raw PCM at a specific sample rate
 * - `ulaw_8000`, `alaw_8000`: Telephony codecs at 8 kHz
 */
export type TTSOutputFormat = 'wav' | 'pcm' | 'opus' | 'ulaw_8000' | 'alaw_8000' | `pcm_${number}`;

/** Languages supported by Gradium TTS */
export type TTSLanguage = 'en' | 'fr' | 'de' | 'es' | 'pt';

/** Default voice ID (Emma, English feminine) */
export const TTSDefaultVoiceId = 'YTpq7expH9539ERJ';
