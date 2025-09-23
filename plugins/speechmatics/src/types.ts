// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type EndOfUtteranceMode = 'none' | 'fixed' | 'adaptive';

export type OperatingPoint = 'standard' | 'enhanced';

export type AdditionalVocabEntry = {
  content: string;
  sounds_like?: string[];
};

export type PunctuationOverrides = {
  sensitivity?: number;      // 0..1
  permitted_marks?: string[]; // remove "all"
};

export type DiarizationFocusMode = 'retain' | 'ignore';

export type KnownSpeaker = { label: string; speaker_identifiers: string[] };

export type SpeechmaticsSTTOptions = {
  apiKey?: string;                 // OR pass a JWT via getJwt()
  baseUrl?: string;                // e.g. "wss://eu2.rt.speechmatics.com/v2"
  appId?: string;                  // sm-app tag
  operatingPoint?: OperatingPoint; // enhanced recommended
  language?: string;               // "en"
  outputLocale?: string;           // "en-GB"
  enablePartials?: boolean;
  enableDiarization?: boolean;
  maxDelay?: number;               // 0.7
  endOfUtteranceSilence?: number;  // 0.3s
  endOfUtteranceMode?: EndOfUtteranceMode;
  additionalVocab?: AdditionalVocabEntry[];
  punctuationOverrides?: PunctuationOverrides;
  diarizationSensitivity?: number; // 0..1
  speakerActiveFormat?: string;    // e.g. "<{speaker_id}>{text}</{speaker_id}>"
  speakerPassiveFormat?: string;   // e.g. "{text}"
  preferCurrentSpeaker?: boolean;
  focusSpeakers?: string[];
  ignoreSpeakers?: string[];
  focusMode?: DiarizationFocusMode;
  knownSpeakers?: KnownSpeaker[];
  sampleRate?: number;             // default 16000
  chunkSize?: number;              // internal audio chunking to WS
  /** Optional override to fetch a temporary JWT (recommended) */
  getJwt?: () => Promise<string>;
};