// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioFrame,
  AudioStream,
  type FrameProcessor,
  type NoiseCancellationOptions,
  RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  TrackSource,
  isFrameProcessor,
} from '@livekit/rtc-node';
import { type ReadableStream, TransformStream } from 'node:stream/web';
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
  private track: RemoteTrack | null = null;
  private participantIdentity: string | null = null;
  private currentInput: {
    id: string;
    stream: ReadableStream<AudioFrame>;
    pipe: Promise<void>;
  } | null = null;
  private streamTransition: Promise<void> | null = null;
  private attached = true;
  private closed = false;
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
    if (isFrameProcessor<FrameProcessor<AudioFrame>>(noiseCancellation)) {
      this.frameProcessor = noiseCancellation;
    } else {
      this.noiseCancellation = noiseCancellation;
    }

    this.room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    this.room.on(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
    this.room.on(RoomEvent.TrackUnpublished, this.onTrackUnpublished);
  }

  setParticipant(participant: RemoteParticipant | string | null) {
    const participantIdentity =
      participant instanceof RemoteParticipant ? participant.identity : participant;
    this.logger.debug(
      { 'lk.pii.participant_identity': participantIdentity },
      'setting participant audio input',
    );

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
        'lk.pii.participant_identity': participantValue?.identity,
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

  override setAttached(attached: boolean): void {
    this.attached = attached;
  }

  override onAttached(): void {
    this.logger.debug(
      { 'lk.pii.participant_identity': this.participantIdentity },
      'input stream attached',
    );
  }

  override onDetached(): void {
    this.logger.debug(
      { 'lk.pii.participant_identity': this.participantIdentity },
      'input stream detached',
    );
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
    this.updateStream(null, null);
  }

  private updateStream(track: RemoteTrack | null, publication: RemoteTrackPublication | null) {
    this.track = track;
    this.publication = publication;

    if (track && publication && !this.streamTransition && !this.currentInput) {
      this.openStream(track);
      return;
    }

    const previousTransition = this.streamTransition ?? Promise.resolve();
    const transition = previousTransition.then(async () => {
      try {
        await this.closeCurrentInput();
        if (
          !track ||
          !publication ||
          this.closed ||
          this.track !== track ||
          this.publication !== publication
        ) {
          return;
        }
        this.openStream(track);
      } catch (error) {
        this.logger.error({ error }, 'failed to update participant audio input');
      }
    });
    this.streamTransition = transition;
    void transition.then(() => {
      if (this.streamTransition === transition) {
        this.streamTransition = null;
      }
    });
  }

  private async closeCurrentInput() {
    const input = this.currentInput;
    this.currentInput = null;

    if (input) {
      await this.multiStream.removeInputStream(input.id);
      const [cancelResult] = await Promise.allSettled([input.stream.cancel(), input.pipe]);
      if (cancelResult.status === 'rejected') {
        throw cancelResult.reason;
      }
    }
  }

  private openStream(track: RemoteTrack) {
    const output = new TransformStream<AudioFrame, AudioFrame>({
      transform: (frame, controller) => {
        if (this.attached) {
          controller.enqueue(frame);
        }
      },
    });
    const inputPipe = resampleStream({
      stream: this.createStream(track),
      outputRate: this.sampleRate,
    }).pipeTo(output.writable);
    const input = {
      id: this.multiStream.addInputStream(output.readable),
      stream: output.readable,
      pipe: inputPipe,
    };
    this.currentInput = input;
    void inputPipe.catch((error) => {
      if (this.currentInput === input) {
        this.logger.error({ error }, 'participant audio input stream failed');
      }
    });
  }

  private onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): boolean => {
    this.logger.debug(
      { 'lk.pii.participant_identity': participant.identity },
      'onTrackSubscribed in _input',
    );
    if (
      this.closed ||
      this.participantIdentity !== participant.identity ||
      publication.source !== TrackSource.SOURCE_MICROPHONE ||
      (this.publication?.sid === publication.sid && this.track === track)
    ) {
      return false;
    }
    this.updateStream(track, publication);
    return true;
  };

  private onTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (
      this.track !== track ||
      this.publication?.sid !== publication.sid ||
      participant.identity !== this.participantIdentity
    ) {
      return;
    }

    this.closeStream();

    // Same-publication replacements arrive through TrackSubscribed.
    for (const candidate of participant.trackPublications.values()) {
      if (candidate.sid === publication.sid || !candidate.track) {
        continue;
      }
      if (this.onTrackSubscribed(candidate.track, candidate, participant)) {
        return;
      }
    }
  };

  private createStream(track: RemoteTrack): ReadableStream<AudioFrame> {
    return new AudioStream(track, {
      sampleRate: this.sampleRate,
      numChannels: this.numChannels,
      noiseCancellation: this.frameProcessor || this.noiseCancellation,
      // Don't let the AudioStream close the processor when the track switches —
      // this input stream owns the processor across track changes and closes it
      // itself in close().
      autoCloseNoiseCancellation: false,
      // TODO(AJS-269): resolve compatibility issue with node-sdk to remove the forced type casting
    }) as unknown as ReadableStream<AudioFrame>;
  }

  override async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    this.room.off(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
    this.room.off(RoomEvent.TrackUnpublished, this.onTrackUnpublished);
    this.closeStream();
    await this.streamTransition;
    await super.close();

    this.frameProcessor?.close();
    this.frameProcessor = undefined;
  }
}
