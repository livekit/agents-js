// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TTS providers supported by speech-sdk, used as the prefix of a `provider/model` string.
 */
export type TTSProviders =
  | 'cartesia'
  | 'deepgram'
  | 'elevenlabs'
  | 'fal-ai'
  | 'fish-audio'
  | 'google'
  | 'hume'
  | 'inworld'
  | 'minimax'
  | 'mistral'
  | 'murf'
  | 'openai'
  | 'resemble'
  | 'smallest-ai'
  | 'xai';

/**
 * A `provider/model` string, e.g. `openai/gpt-4o-mini-tts` or `elevenlabs/eleven_flash_v2_5`.
 */
export type TTSModels = `${TTSProviders}/${string}`;
