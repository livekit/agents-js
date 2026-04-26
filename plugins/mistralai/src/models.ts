// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Ref: python livekit-plugins/livekit-plugins-mistralai/livekit/plugins/mistralai/models.py - 3-18 lines
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

// Ref: python livekit-plugins/livekit-plugins-mistralai/livekit/plugins/mistralai/models.py - 21-26 lines
export type MistralSTTModels =
  | 'voxtral-mini-transcribe-realtime-2602'
  | 'voxtral-mini-latest'
  | 'voxtral-mini-2602'
  | 'voxtral-mini-2507';

// Ref: python livekit-plugins/livekit-plugins-mistralai/livekit/plugins/mistralai/models.py - 28 lines
export type MistralTTSModels = 'voxtral-mini-tts-latest' | 'voxtral-mini-tts-2603';

// Ref: python livekit-plugins/livekit-plugins-mistralai/livekit/plugins/mistralai/models.py - 30-60 lines
export type MistralTTSVoices =
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
