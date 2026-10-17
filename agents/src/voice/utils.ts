// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Participant } from '@livekit/rtc-node';
import type { Span } from '@opentelemetry/api';
import { participantAttributes } from '../telemetry/index.js';

export function createSilenceFrame(
  duration: number,
  sampleRate: number,
  numChannels = 1,
): AudioFrame {
  const samples = Math.floor((duration * sampleRate) / 1000);
  return new AudioFrame(new Int16Array(samples * numChannels), sampleRate, numChannels, samples);
}

export function createSilenceFrameLike(frame: AudioFrame): AudioFrame {
  return new AudioFrame(
    new Int16Array(frame.samplesPerChannel * frame.channels),
    frame.sampleRate,
    frame.channels,
    frame.samplesPerChannel,
  );
}

export function setParticipantSpanAttributes(
  span: Span,
  participant: Pick<Participant, 'sid' | 'identity' | 'kind'>,
): void {
  span.setAttributes(participantAttributes(participant));
}
