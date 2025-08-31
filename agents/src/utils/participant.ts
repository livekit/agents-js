
import { Room, Participant, Track, RemoteParticipant } from 'livekit-client';

export function waitForParticipant(
  room: Room,
  identity?: string,
  options?: { kind?: string },
): Promise<RemoteParticipant> {
  return new Promise((resolve) => {
    if (identity) {
      const p = room.getParticipantByIdentity(identity);
      if (p) {
        resolve(p as RemoteParticipant);
        return;
      }
    }

    const listener = (p: Participant) => {
      if (identity && p.identity === identity) {
        resolve(p as RemoteParticipant);
        room.off('participantConnected', listener);
      } else if (options?.kind === 'agent' && p.metadata?.includes('agent')) {
        resolve(p as RemoteParticipant);
        room.off('participantConnected', listener);
      }
    };
    room.on('participantConnected', listener);
  });
}

export function waitForTrackPublication(
  room: Room,
  identity: string,
  kind?: Track.Kind,
): Promise<void> {
  return new Promise((resolve) => {
    const p = room.getParticipantByIdentity(identity);
    if (p) {
      for (const t of p.tracks.values()) {
        if (!kind || t.kind === kind) {
          resolve();
          return;
        }
      }
    }

    const listener = (track: Track, p: Participant) => {
      if (p.identity === identity && (!kind || track.kind === kind)) {
        resolve();
        room.off('trackPublished', listener);
      }
    };
    room.on('trackPublished', listener);
  });
}
