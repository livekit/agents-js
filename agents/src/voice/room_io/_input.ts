// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioStream,
  type NoiseCancellationOptions,
  RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  TrackSource,
} from '@livekit/rtc-node';
import { log } from '../../log.js';
import { resampleStream } from '../../utils.js';
import { AudioInput } from '../io.js';

export class ParticipantAudioInputStream extends AudioInput {
  private room: Room;
  private sampleRate: number;
  private numChannels: number;
  private noiseCancellation?: NoiseCancellationOptions;
  private publication: RemoteTrackPublication | null = null;
  private participantIdentity: string | null = null;
  private logger = log();
  constructor({
    room,
    sampleRate,
    numChannels,
    noiseCancellation,
  }: {
    room: Room;
    sampleRate: number;
    numChannels: number;
    noiseCancellation?: NoiseCancellationOptions;
  }) {
    super();
    this.room = room;
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;
    this.noiseCancellation = noiseCancellation;

    this.room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    this.room.on(RoomEvent.TrackUnpublished, this.onTrackUnpublished);
  }

  setParticipant(participant: RemoteParticipant | string | null) {
    this.logger.debug({ participant }, 'setting participant audio input');
    const participantIdentity =
      participant instanceof RemoteParticipant ? participant.identity : participant;

    if (this.participantIdentity === participantIdentity) {
      return;
    }
    this.participantIdentity = participantIdentity;
    this.closeStream();

    if (!participantIdentity) {
      return;
    }

    const participantValue =
      participant instanceof RemoteParticipant
        ? participant
        : this.room.remoteParticipants.get(participantIdentity);

    if (participantValue) {
      for (const publication of Object.values(participantValue.trackPublications)) {
        if (publication.track && publication.source === TrackSource.SOURCE_MICROPHONE) {
          this.onTrackSubscribed(publication.track, publication, participantValue);
          break;
        }
      }
    }
  }

  private onTrackUnpublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (
      this.publication?.sid !== publication.sid ||
      participant.identity !== this.participantIdentity
    ) {
      return;
    }
    this.closeStream();

    // subscribe to the first available track
    for (const publication of participant.trackPublications.values()) {
      if (
        publication.track &&
        this.onTrackSubscribed(publication.track, publication, participant)
      ) {
        return;
      }
    }
  };

  private closeStream() {
    if (this.deferredStream.isSourceSet) {
      this.deferredStream.detachSource();
    }
    this.publication = null;
  }

  private onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): boolean => {
    if (
      this.participantIdentity !== participant.identity ||
      publication.source !== TrackSource.SOURCE_MICROPHONE ||
      (this.publication && this.publication.sid === publication.sid)
    ) {
      return false;
    }
    this.closeStream();
    this.publication = publication;
    this.deferredStream.setSource(
      resampleStream({
        stream: this.createStream(track),
        outputRate: this.sampleRate,
      }),
    );
    return true;
  };

  private createStream(track: RemoteTrack) {
    return new AudioStream(track, {
      sampleRate: this.sampleRate,
      numChannels: this.numChannels,
      noiseCancellation: this.noiseCancellation,
    });
  }
}
