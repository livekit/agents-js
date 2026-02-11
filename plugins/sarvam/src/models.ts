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

/** Supported output audio codecs */
export type TTSAudioCodecs = 'mp3' | 'linear16' | 'mulaw' | 'alaw' | 'opus' | 'flac' | 'aac' | 'wav';
