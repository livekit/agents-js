// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type TTSModels =
  | 'eleven_monolingual_v1'
  | 'eleven_multilingual_v1'
  | 'eleven_multilingual_v2'
  | 'eleven_turbo_v2'
  | 'eleven_turbo_v2_5';

export type TTSEncoding =
  // XXX(nbsp): MP3 is not yet supported
  // | 'mp3_22050_32'
  // | 'mp3_44100_32'
  // | 'mp3_44100_64'
  // | 'mp3_44100_96'
  // | 'mp3_44100_128'
  // | 'mp3_44100_192'
  'pcm_16000' | 'pcm_22050' | 'pcm_44100';
