// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioFrame,
  AudioStream,
  type NoiseCancellationOptions,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  TrackSource,
} from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { log } from '../../log.js';
import { DeferredReadableStream } from '../../stream/deferred_stream.js';

export class ParticipantAudioInputStream {
  private room: Room;
  private sampleRate: number;
  private numChannels: number;
  private noiseCancellation?: NoiseCancellationOptions;
  private publication?: RemoteTrackPublication;
  private participantIdentity?: string;
  private logger = log();
  private deferredStream: DeferredReadableStream<AudioFrame> =
    new DeferredReadableStream<AudioFrame>();

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
    this.room = room;
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;
    this.noiseCancellation = noiseCancellation;

    this.room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
  }

  get audioStream(): ReadableStream<AudioFrame> {
    return this.deferredStream.stream;
  }

  setParticipant(participant: RemoteParticipant | string | null) {
    this.logger.debug({ participant }, 'setting participant');
    if (this.participantIdentity) {
      throw new Error('Changing participant is not supported yet');
    }

    this.participantIdentity =
      typeof participant === 'string' ? participant : participant?.identity;

    for (const [_, participant] of this.room.remoteParticipants) {
      for (const publication of Object.values(participant.trackPublications)) {
        if (publication.track && publication.source === TrackSource.SOURCE_MICROPHONE) {
          this.onTrackSubscribed(publication.track, publication, participant);
          break;
        }
      }
    }
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
    this.publication = publication;
    this.logger.debug({ track, publication, participant }, 'track subscribed');
    this.deferredStream.setSource(this.createStream(track));
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
