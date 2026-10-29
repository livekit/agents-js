// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export type MistralChatModels =
  | 'mistral-large-latest'
  | 'mistral-large-2512'
  | 'mistral-large-2411'
  | 'mistral-medium-latest'
  | 'mistral-medium-2508'
  | 'mistral-medium-2505'
  | 'mistral-small-latest'
  | 'mistral-small-2603'
  | 'mistral-small-2506'
  | 'ministral-14b-latest'
  | 'ministral-14b-2512'
  | 'ministral-8b-latest'
  | 'ministral-8b-2512'
  | 'ministral-3b-latest'
  | 'ministral-3b-2512';

export type MistralSTTModels =
  | 'voxtral-mini-transcribe-realtime-2602'
  | 'voxtral-mini-latest'
  | 'voxtral-mini-2602'
  | 'voxtral-mini-2507';

export type MistralTTSModels =
  | 'voxtral-mini-tts-3'
  | 'voxtral-mini-tts-latest'
  | 'voxtral-mini-tts-2603';

export type MistralTTSVoxtral2Voices =
  | 'gb_jane_confident'
  | 'gb_jane_confused'
  | 'gb_jane_curious'
  | 'gb_jane_frustrated'
  | 'gb_jane_jealousy'
  | 'gb_jane_neutral'
  | 'gb_jane_sad'
  | 'gb_jane_sarcasm'
  | 'gb_jane_shameful'
  | 'fr_marie_angry'
  | 'fr_marie_curious'
  | 'fr_marie_excited'
  | 'fr_marie_happy'
  | 'fr_marie_neutral'
  | 'fr_marie_sad'
  | 'gb_oliver_angry'
  | 'gb_oliver_cheerful'
  | 'gb_oliver_confident'
  | 'gb_oliver_curious'
  | 'gb_oliver_excited'
  | 'gb_oliver_neutral'
  | 'gb_oliver_sad'
  | 'en_paul_angry'
  | 'en_paul_cheerful'
  | 'en_paul_confident'
  | 'en_paul_excited'
  | 'en_paul_frustrated'
  | 'en_paul_happy'
  | 'en_paul_neutral'
  | 'en_paul_sad';

/** Voices introduced with Voxtral 3. Voxtral 3 also accepts the Voxtral 2 voices. */
export type MistralTTSVoxtral3Voices =
  | 'voice_479'
  | 'voice_3143'
  | 'voice_481'
  | 'voice_1788'
  | 'voice_591'
  | 'voice_590'
  | 'voice_3147'
  | 'voice_3149'
  | 'voice_1787'
  | 'voice_1786'
  | 'voice_3150'
  | 'voice_447'
  | 'voice_485'
  | 'voice_478'
  | 'voice_483'
  | 'voice_3141'
  | 'voice_589'
  | 'voice_3137'
  | 'voice_592'
  | 'voice_3139'
  | 'voice_3153'
  | 'voice_3146'
  | 'voice_482'
  | 'voice_3133'
  | 'voice_3135'
  | 'voice_3136'
  | 'voice_3145'
  | 'voice_3134'
  | 'voice_3154'
  | 'voice_480'
  | 'voice_3155'
  | 'voice_3132'
  | 'voice_3138'
  | 'voice_3140'
  | 'voice_3144'
  | 'voice_3142';

export type MistralTTSVoices = MistralTTSVoxtral2Voices | MistralTTSVoxtral3Voices;
