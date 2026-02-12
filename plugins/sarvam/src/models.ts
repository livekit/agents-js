// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Supported Sarvam AI TTS models */
export type TTSModels = 'bulbul:v2' | 'bulbul:v3';

/** Speakers available on bulbul:v3 (30+ voices) */
export type TTSV3Speakers =
  | 'shubh'
  | 'aditya'
  | 'ritu'
  | 'priya'
  | 'neha'
  | 'rahul'
  | 'pooja'
  | 'rohan'
  | 'simran'
  | 'kavya'
  | 'amit'
  | 'dev'
  | 'ishita'
  | 'shreya'
  | 'ratan'
  | 'varun'
  | 'manan'
  | 'sumit'
  | 'roopa'
  | 'kabir'
  | 'aayan'
  | 'ashutosh'
  | 'advait'
  | 'amelia'
  | 'sophia'
  | 'anand'
  | 'tanya'
  | 'tarun'
  | 'sunny'
  | 'mani'
  | 'gokul'
  | 'vijay'
  | 'shruti'
  | 'suhani'
  | 'mohit'
  | 'kavitha'
  | 'rehan'
  | 'soham'
  | 'rupali';

/** Speakers available on bulbul:v2 */
export type TTSV2Speakers =
  | 'anushka'
  | 'manisha'
  | 'vidya'
  | 'arya'
  | 'abhilash'
  | 'karun'
  | 'hitesh';

/** All supported speakers across both models */
export type TTSSpeakers = TTSV2Speakers | TTSV3Speakers;

/** Supported language codes for Sarvam AI TTS (BCP-47) */
export type TTSLanguages =
  | 'bn-IN'
  | 'en-IN'
  | 'gu-IN'
  | 'hi-IN'
  | 'kn-IN'
  | 'ml-IN'
  | 'mr-IN'
  | 'od-IN'
  | 'pa-IN'
  | 'ta-IN'
  | 'te-IN';

/** Supported output sample rates in Hz */
export type TTSSampleRates = 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;

// ---------------------------------------------------------------------------
// STT model types
// ---------------------------------------------------------------------------

/**
 * Supported Sarvam AI STT models.
 *
 * @remarks
 * `saarika:v2.5` will be deprecated soon. Prefer `saaras:v3` for new integrations.
 * All languages supported by `saarika:v2.5` are also available in `saaras:v3`.
 *
 * @see {@link https://docs.sarvam.ai/api-reference-docs/getting-started/models/saaras | Saaras model docs}
 */
export type STTModels = 'saaras:v3' | 'saarika:v2.5';

/** Transcription modes available on saaras:v3 */
export type STTModes = 'transcribe' | 'translate' | 'verbatim' | 'translit' | 'codemix';

/**
 * Languages supported by saarika:v2.5 (11 Indian languages).
 * All of these are also available in {@link STTV3Languages}.
 */
export type STTV2Languages =
  | 'unknown'
  | 'hi-IN'
  | 'bn-IN'
  | 'kn-IN'
  | 'ml-IN'
  | 'mr-IN'
  | 'od-IN'
  | 'pa-IN'
  | 'ta-IN'
  | 'te-IN'
  | 'en-IN'
  | 'gu-IN';

/** saaras:v3 supports all v2 languages plus 12 additional ones (22 Indian + English) */
export type STTV3Languages =
  | STTV2Languages
  | 'as-IN'
  | 'ur-IN'
  | 'ne-IN'
  | 'kok-IN'
  | 'ks-IN'
  | 'sd-IN'
  | 'sa-IN'
  | 'sat-IN'
  | 'mni-IN'
  | 'brx-IN'
  | 'mai-IN'
  | 'doi-IN';

/** All supported STT language codes */
export type STTLanguages = STTV2Languages | STTV3Languages;

