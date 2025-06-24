// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AgentAttributes, TranscriptionAttributes } from './attributes.js';

// Agent attributes
export const AGENT_STATE_ATTRIBUTE = 'lk.agent.state' as const satisfies keyof AgentAttributes;
export const ATTRIBUTE_PUBLISH_ON_BEHALF =
  'lk.publish_on_behalf' as const satisfies keyof AgentAttributes;

// Transcription attributes
export const ATTRIBUTE_TRANSCRIPTION_TRACK_ID =
  'lk.transcribed_track_id' as const satisfies keyof TranscriptionAttributes;
export const ATTRIBUTE_TRANSCRIPTION_FINAL =
  'lk.transcription_final' as const satisfies keyof TranscriptionAttributes;
export const ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID =
  'lk.segment_id' as const satisfies keyof TranscriptionAttributes;

// Topics
export const TOPIC_TRANSCRIPTION = 'lk.transcription' as const;
export const TOPIC_CHAT = 'lk.chat' as const;
