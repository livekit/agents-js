// SPDX-FileCopyrightText: 2026 Gandr
//
// SPDX-License-Identifier: Apache-2.0

/** Gandr TTS model ids accepted by the OpenAI-compatible audio endpoint. */
export type TTSModels = 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts' | (string & {});

/** Stock voice ids. Any OpenAI voice alias and any `gnd:` clone id also work. */
export type TTSVoices =
  | 'gandr-mia'
  | 'gandr-ava'
  | 'gandr-jenny'
  | 'gandr-dane'
  | 'gandr-leo'
  | 'gandr-lewis'
  | (string & {});

/** Reference: https://github.com/Gandr-AI/gandr-livekit */