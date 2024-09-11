import type {
  LocalParticipant,
  RemoteParticipant,
  Room,
  TrackPublication,
} from '@livekit/rtc-node';
import { TrackSource } from '@livekit/rtc-node';
import { v4 as uuidv4 } from 'uuid';

export function findMicroTrackId(room: Room, identity: string): string {
  let p: RemoteParticipant | LocalParticipant | undefined = room.remoteParticipants.get(identity);

  if (identity === room.localParticipant?.identity) {
    p = room.localParticipant;
  }

  if (!p) {
    throw new Error(`participant ${identity} not found`);
  }

  // find first micro track
  let trackId: string | undefined;
  p.trackPublications.forEach((track: TrackPublication) => {
    if (track.source === TrackSource.SOURCE_MICROPHONE) {
      trackId = track.sid;
      return;
    }
  });

  if (!trackId) {
    throw new Error(`participant ${identity} does not have a microphone track`);
  }

  return trackId;
}

export function segmentUuid(): string {
  return 'SG_' + uuidv4().replace(/-/g, '').substring(0, 12);
}
