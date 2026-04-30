// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type MistralChatModels =
  | 'mistral-large-latest'
  | 'mistral-medium-latest'
  | 'mistral-small-latest'
  | 'mistral-tiny-latest'
  | 'magistral-medium-latest'
  | 'magistral-small-latest'
  | 'ministral-3b-latest'
  | 'ministral-8b-latest'
  | 'open-mistral-nemo'
  | 'open-codestral-mamba';

export type MistralSTTModels =
  | 'voxtral-mini-transcribe-realtime-2602' //realtime streaming
  | 'voxtral-mini-2602' //batch transcription
  | 'voxtral-mini-transcribe-2507'; //batch transcription (deprecated)

export type MistralTTSModels = 'voxtral-mini-tts-2603';
