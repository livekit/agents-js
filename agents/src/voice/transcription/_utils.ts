// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LocalParticipant, Participant, Room } from '@livekit/rtc-node';
import { TrackSource } from '@livekit/rtc-node';

export function findMicrophoneTrackId(room: Room, identity: string): string {
  let p: Participant | LocalParticipant | null = room.remoteParticipants.get(identity) ?? null;
  if (identity === room.localParticipant?.identity) {
    p = room.localParticipant;
  }

  if (p === null) {
    throw new Error(`Participant ${identity} not found`);
  }

  for (const track of p.trackPublications.values()) {
    if (track.source === TrackSource.SOURCE_MICROPHONE && track.sid) {
      // find the first microphone track
      return track.sid;
    }
  }

  throw new Error(`Participant ${identity} does not have a microphone track`);
}
