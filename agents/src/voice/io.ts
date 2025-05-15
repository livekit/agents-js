// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { SpeechEvent } from '../stt/stt.js';

export type STTNode = (
  audio: ReadableStream<AudioFrame>,
  modelSettings: any, // TODO(shubhra): add type
) => Promise<ReadableStream<SpeechEvent | string> | null>;
