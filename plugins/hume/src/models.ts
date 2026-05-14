// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Hume AI voice provider */
export enum HumeVoiceProvider {
  Hume = 'HUME_AI',
  Custom = 'CUSTOM_VOICE',
}

/** Voice specification by ID */
export interface VoiceById {
  id: string;
  provider?: HumeVoiceProvider;
}

/** Voice specification by name */
export interface VoiceByName {
  name: string;
  provider?: HumeVoiceProvider;
}

/** An utterance for context or synthesis */
export interface Utterance {
  text: string;
  description?: string;
  speed?: number;
  voice?: VoiceById | VoiceByName;
  trailing_silence?: number;
}

/** Supported model versions */
export type ModelVersion = '1' | '2';

/** Configuration options for Hume AI TTS */
export interface TTSOptions {
  apiKey?: string;
  baseUrl?: string;
  voice?: VoiceById | VoiceByName;
  modelVersion?: ModelVersion;
  description?: string;
  speed?: number;
  trailingSilence?: number;
  context?: string | Utterance[];
  instantMode?: boolean;
}
