// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type TTSModels =
  | 'eleven_monolingual_v1'
  | 'eleven_multilingual_v1'
  | 'eleven_multilingual_v2'
  | 'eleven_flash_v2'
  | 'eleven_flash_v2_5'
  | 'eleven_turbo_v2'
  | 'eleven_turbo_v2_5'
  | 'eleven_v3';

export type TTSEncoding =
  // XXX(nbsp): MP3 is not yet supported
  // | 'mp3_22050_32'
  // | 'mp3_44100_32'
  // | 'mp3_44100_64'
  // | 'mp3_44100_96'
  // | 'mp3_44100_128'
  // | 'mp3_44100_192'
  'pcm_16000' | 'pcm_22050' | 'pcm_44100';

export type STTModels = 'scribe_v1' | 'scribe_v2' | 'scribe_v2_realtime';

export type STTAudioFormat = 'pcm_16000' | 'pcm_22050' | 'pcm_44100';

export type STTCommitStrategy = 'vad' | 'manual';

export type STTLanguages =
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'it'
  | 'pt'
  | 'pl'
  | 'nl'
  | 'sv'
  | 'fi'
  | 'da'
  | 'no'
  | 'cs'
  | 'ro'
  | 'sk'
  | 'uk'
  | 'el'
  | 'tr'
  | 'ru'
  | 'bg'
  | 'hr'
  | 'sr'
  | 'hu'
  | 'lt'
  | 'lv'
  | 'et'
  | 'ja'
  | 'zh'
  | 'ko'
  | 'hi'
  | 'ar'
  | 'fa'
  | 'he'
  | 'id'
  | 'ms'
  | 'th'
  | 'vi'
  | 'ta'
  | 'ur';
