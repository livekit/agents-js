// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Ref: python livekit-plugins/livekit-plugins-cartesia/livekit/plugins/cartesia/models.py - 11 lines
export type TTSModels =
  | 'sonic'
  | 'sonic-2'
  | 'sonic-3'
  | 'sonic-lite'
  | 'sonic-preview'
  | 'sonic-turbo';

export type TTSLanguages = 'en' | 'es' | 'fr' | 'de' | 'pt' | 'zh' | 'ja';

export const TTSDefaultVoiceId = 'f786b574-daa5-4673-aa0c-cbe3e8534c02';

export const isSonic3 = (model: string): boolean => model.startsWith('sonic-3');

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
