// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioFrame,
  AudioStream,
  FrameProcessor,
  type NoiseCancellationOptions,
  RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  TrackSource,
} from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { log } from '../../log.js';
import { resampleStream } from '../../utils.js';
import { AudioInput } from '../io.js';

export class ParticipantAudioInputStream extends AudioInput {
  private room: Room;
  private sampleRate: number;
  private numChannels: number;
  private noiseCancellation?: NoiseCancellationOptions;
  private frameProcessor?: FrameProcessor<AudioFrame>;
  private publication: RemoteTrackPublication | null = null;
  private participantIdentity: string | null = null;
  private currentInputId: string | null = null;
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
    noiseCancellation?: NoiseCancellationOptions | FrameProcessor<AudioFrame>;
  }) {
    super();
    this.room = room;
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;
    if (noiseCancellation instanceof FrameProcessor) {
      this.frameProcessor = noiseCancellation;
    } else {
      this.noiseCancellation = noiseCancellation;
    }

    this.room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    this.room.on(RoomEvent.TrackUnpublished, this.onTrackUnpublished);
    this.room.on(RoomEvent.TokenRefreshed, this.onTokenRefreshed);
  }

  setParticipant(participant: RemoteParticipant | string | null) {
    this.logger.debug({ participant }, 'setting participant audio input');
    const participantIdentity =
      participant instanceof RemoteParticipant ? participant.identity : participant;

    if (this.participantIdentity === participantIdentity) {
      return;
    }
    if (this.participantIdentity) {
      this.closeStream();
    }
    this.participantIdentity = participantIdentity;

    if (!participantIdentity) {
      return;
    }

    const participantValue =
      participant instanceof RemoteParticipant
        ? participant
        : this.room.remoteParticipants.get(participantIdentity);

    // Convert Map iterator to array for Pino serialization
    const trackPublicationsArray = Array.from(participantValue?.trackPublications.values() ?? []);

    this.logger.info(
      {
        participantValue: participantValue?.identity,
        trackPublications: trackPublicationsArray,
        lengthOfTrackPublications: trackPublicationsArray.length,
      },
      'participantValue.trackPublications',
    );
    // We need to check if the participant has a microphone track and subscribe to it
    // in case we miss the tracksubscribed event
    if (participantValue) {
      for (const publication of participantValue.trackPublications.values()) {
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
    if (this.currentInputId) {
      void this.multiStream.removeInputStream(this.currentInputId);
      this.currentInputId = null;
    }

    this.publication = null;
  }

  private onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): boolean => {
    this.logger.debug({ participant: participant.identity }, 'onTrackSubscribed in _input');
    if (
      this.participantIdentity !== participant.identity ||
      publication.source !== TrackSource.SOURCE_MICROPHONE ||
      (this.publication && this.publication.sid === publication.sid)
    ) {
      return false;
    }
    this.closeStream();
    this.publication = publication;
    this.currentInputId = this.multiStream.addInputStream(
      resampleStream({
        stream: this.createStream(track),
        outputRate: this.sampleRate,
      }),
    );
    this.frameProcessor?.onStreamInfoUpdated({
      participantIdentity: participant.identity,
      roomName: this.room.name!,
      publicationSid: publication.sid!,
    });
    this.frameProcessor?.onCredentialsUpdated({
      token: this.room.token!,
      url: this.room.serverUrl!,
    });
    return true;
  };

  private onTokenRefreshed = () => {
    if (this.room.token && this.room.serverUrl) {
      this.frameProcessor?.onCredentialsUpdated({
        token: this.room.token,
        url: this.room.serverUrl,
      });
    }
  };

  private createStream(track: RemoteTrack): ReadableStream<AudioFrame> {
    return new AudioStream(track, {
      sampleRate: this.sampleRate,
      numChannels: this.numChannels,
      noiseCancellation: this.frameProcessor || this.noiseCancellation,
      // TODO(AJS-269): resolve compatibility issue with node-sdk to remove the forced type casting
    }) as unknown as ReadableStream<AudioFrame>;
  }

  override async close() {
    this.room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    this.room.off(RoomEvent.TrackUnpublished, this.onTrackUnpublished);
    this.room.off(RoomEvent.TokenRefreshed, this.onTokenRefreshed);
    this.closeStream();
    await super.close();

    this.frameProcessor?.close();
    this.frameProcessor = undefined;
  }
}
