// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type STTModels =
  | 'universal-streaming-english'
  | 'universal-streaming-multilingual'
  | 'u3-rt-pro'
  // Deprecated alias — AssemblyAI maps this to `u3-rt-pro` server-side, but the
  // Python plugin emits a warning and rewrites it. Kept here so TS users don't
  // break if they already pass it.
  | 'u3-pro';

export type STTEncoding = 'pcm_s16le' | 'pcm_mulaw';
