// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export type EndOfUtteranceMode = 'none' | 'fixed' | 'adaptive';
export type OperatingPoint = 'standard' | 'enhanced';

export type AdditionalVocabEntry = {
  content: string;
  sounds_like?: string[];
};

export type PunctuationOverrides = {
  sensitivity?: number;
  permitted_marks?: string[];
};

export type DiarizationFocusMode = 'retain' | 'ignore';

export type KnownSpeaker = {
  label: string;
  speaker_identifiers: string[];
};

export type SpeechmaticsSTTOptions = {
  apiKey?: string;
  baseUrl?: string;
  appId?: string;
  operatingPoint?: OperatingPoint;
  language?: string;
  outputLocale?: string;
  enablePartials?: boolean;
  enableDiarization?: boolean;
  maxDelay?: number;
  endOfUtteranceSilence?: number;
  endOfUtteranceMode?: EndOfUtteranceMode;
  additionalVocab?: AdditionalVocabEntry[];
  punctuationOverrides?: PunctuationOverrides;
  diarizationSensitivity?: number;
  speakerActiveFormat?: string;
  speakerPassiveFormat?: string;
  preferCurrentSpeaker?: boolean;
  focusSpeakers?: string[];
  ignoreSpeakers?: string[];
  focusMode?: DiarizationFocusMode;
  knownSpeakers?: KnownSpeaker[];
  sampleRate?: number;
  chunkSize?: number;
  /** Optional override to fetch a temporary JWT (recommended) */
  getJwt?: () => Promise<string>;
};
