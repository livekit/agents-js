// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Participant, type ParticipantKind } from '@livekit/rtc-node';
import type { Span } from '@opentelemetry/api';
import { traceTypes } from '../telemetry/index.js';

export function createSilenceFrame(
  durationInS: number,
  sampleRate: number,
  numChannels = 1,
): AudioFrame {
  const samples = Math.floor(durationInS * sampleRate);
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
  if (participant.sid) {
    span.setAttribute(traceTypes.ATTR_PARTICIPANT_ID, participant.sid);
  }
  span.setAttribute(traceTypes.ATTR_PARTICIPANT_IDENTITY, participant.identity);
  span.setAttribute(traceTypes.ATTR_PARTICIPANT_KIND, participantKindName(participant.kind));
}

function participantKindName(kind: ParticipantKind): string {
  const names: Record<number, string> = {
    0: 'STANDARD',
    1: 'INGRESS',
    2: 'EGRESS',
    3: 'SIP',
    4: 'AGENT',
    5: 'CONNECTOR',
  };
  return names[kind as number] ?? String(kind);
}
