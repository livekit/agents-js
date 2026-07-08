// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Amazon Polly speech synthesis engine. */
export type TTSSpeechEngine = 'standard' | 'neural' | 'long-form' | 'generative';

/**
 * Language code for the Amazon Polly SynthesizeSpeech request. Only necessary when using a
 * bilingual voice (e.g. Aditi, which supports both `en-IN` and `hi-IN`).
 */
export type TTSLanguage =
  | 'arb'
  | 'cmn-CN'
  | 'cy-GB'
  | 'da-DK'
  | 'de-DE'
  | 'en-AU'
  | 'en-GB'
  | 'en-GB-WLS'
  | 'en-IN'
  | 'en-US'
  | 'es-ES'
  | 'es-MX'
  | 'es-US'
  | 'fr-CA'
  | 'fr-FR'
  | 'is-IS'
  | 'it-IT'
  | 'ja-JP'
  | 'hi-IN'
  | 'ko-KR'
  | 'nb-NO'
  | 'nl-NL'
  | 'pl-PL'
  | 'pt-BR'
  | 'pt-PT'
  | 'ro-RO'
  | 'ru-RU'
  | 'sv-SE'
  | 'tr-TR'
  | 'en-NZ'
  | 'en-ZA'
  | 'ca-ES'
  | 'de-AT'
  | 'yue-CN'
  | 'ar-AE'
  | 'fi-FI'
  | 'en-IE'
  | 'nl-BE'
  | 'fr-BE'
  | 'cs-CZ'
  | 'de-CH';

/** Whether the Amazon Polly input text is plain text or SSML. */
export type TTSTextType = 'text' | 'ssml';
