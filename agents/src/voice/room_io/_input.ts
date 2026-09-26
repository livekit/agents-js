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
import type { Context, Span } from '@opentelemetry/api';
import { type ReadableStream, TransformStream } from 'node:stream/web';
import { log } from '../../log.js';
import { traceTypes, tracer } from '../../telemetry/index.js';
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

  // wait_for_audio_track: linked participant -> first frame
  private trackWaitSpan?: Span;
  private trackWaitStartedAt?: number;
  private traceContext?: Context;
  // parent for track waits outside startup (a participant switch): the session root, so the
  // span lands on the session timeline rather than under whatever task switched participants
  private defaultTraceContext?: Context;

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
    this.endTrackWait();
    this.participantIdentity = participantIdentity;

    if (!participantIdentity) {
      return;
    }
    this.beginTrackWait(participantIdentity);

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

  /** Parent for the next track-wait span (the session's startup bar), never made current. */
  setTraceContext(context: Context | undefined): void {
    this.traceContext = context;
  }

  /** Parent for track waits started outside the startup bar (the session root). */
  setDefaultTraceContext(context: Context | undefined): void {
    this.defaultTraceContext = context;
  }

  private beginTrackWait(participantIdentity: string): void {
    this.trackWaitStartedAt = Date.now();
    this.trackWaitSpan = tracer.startSpan({
      name: 'wait_for_audio_track',
      context: this.traceContext ?? this.defaultTraceContext,
      attributes: { [traceTypes.ATTR_PARTICIPANT_IDENTITY]: participantIdentity },
    });
  }

  private onFirstFrame(): void {
    const span = this.trackWaitSpan;
    if (!span?.isRecording()) return;
    const now = Date.now();
    span.addEvent('first_frame', undefined, now);
    if (this.trackWaitStartedAt !== undefined) {
      span.setAttribute(
        traceTypes.ATTR_FIRST_FRAME_DELAY,
        Math.max(now - this.trackWaitStartedAt, 0) / 1000,
      );
    }
    this.endTrackWait();
  }

  private endTrackWait(): void {
    const span = this.trackWaitSpan;
    this.trackWaitSpan = undefined;
    this.trackWaitStartedAt = undefined;
    if (span?.isRecording()) span.end();
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
    if (track && publication && this.trackWaitSpan?.isRecording()) {
      this.trackWaitSpan.addEvent('track_subscribed', {
        [traceTypes.ATTR_TRACK_SID]: publication.sid ?? '',
        [traceTypes.ATTR_TRACK_SOURCE]:
          publication.source !== undefined
            ? TrackSource[publication.source] ?? String(publication.source)
            : 'unknown',
      });
    }

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
      } catch {
        this.logger.error('failed to update participant audio input');
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
      try {
        await this.multiStream.removeInputStream(input.id);
      } catch {
        this.logger.warn('failed to remove participant audio input stream');
      }

      const [cancelResult] = await Promise.allSettled([input.stream.cancel(), input.pipe]);
      if (cancelResult.status === 'rejected') {
        this.logger.warn('failed to cancel participant audio input stream');
      }
    }
  }

  private openStream(track: RemoteTrack) {
    let firstFrame = true;
    const output = new TransformStream<AudioFrame, AudioFrame>({
      transform: (frame, controller) => {
        if (firstFrame) {
          firstFrame = false;
          this.onFirstFrame();
        }
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
    void inputPipe.catch(() => {
      if (this.currentInput === input) {
        this.logger.error('participant audio input stream failed');
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
    this.endTrackWait();
    await this.streamTransition;
    await super.close();

    this.frameProcessor?.close();
    this.frameProcessor = undefined;
  }
}
