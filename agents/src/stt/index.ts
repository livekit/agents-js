// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export {
  type AvailabilityChangedEvent,
  FallbackAdapter,
  type FallbackAdapterOptions,
} from './fallback_adapter.js';
export { StreamAdapter, StreamAdapterWrapper } from './stream_adapter.js';
export {
  type RecognitionUsage,
  type SpeakerContext,
  type SpeechData,
  type SpeechEvent,
  SpeechEventType,
  SpeechStream,
  STT,
  type STTCallbacks,
  type STTCapabilities,
  isSpeakerContext,
} from './stt.js';
export * as testing from './testing/index.js';
