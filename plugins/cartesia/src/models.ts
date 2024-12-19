// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type TTSModels = 'sonic-english' | 'sonic-multilingual';

export type TTSLanguages = 'en' | 'es' | 'fr' | 'de' | 'pt' | 'zh' | 'ja';

export const TTSDefaultVoiceId = 'c2ac25f9-ecc4-4f56-9095-651354df60c0';

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

export type TTSEncoding =
  // XXX(nbsp): not yet supported
  // | 'pcm_f32le'
  // | 'pcm_mulaw'
  // | 'pcm_alaw'
  'pcm_s16le';
