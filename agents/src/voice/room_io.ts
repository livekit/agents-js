// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioFrame,
  AudioSource,
  LocalAudioTrack,
  type Participant,
  type Room,
} from '@livekit/rtc-node';
import {
  AudioStream,
  type LocalTrackPublication,
  type RemoteTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { ATTRIBUTE_PUBLISH_ON_BEHALF } from '../constants.js';
import { log } from '../log.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { Future, Task } from '../utils.js';
import {
  type AgentSession,
  AgentSessionEvent,
  type UserInputTranscribedEvent,
} from './agent_session.js';
import {
  ParalellTextOutput,
  ParticipantLegacyTranscriptionOutput,
  ParticipantTranscriptionOutput,
} from './room_io/_output.js';

export interface PlaybackFinishedEvent {
  // How much of the audio was played back
  playbackPosition: number;
  // Interrupted is True if playback was interrupted (clearBuffer() was called)
  interrupted: boolean;
  // Transcript synced with playback; may be partial if the audio was interrupted
  // When null, the transcript is not synchronized with the playback
  synchronizedTranscript?: string;
}

export interface AudioOutputOptions {
  sampleRate: number;
  numChannels: number;
  trackPublishOptions: TrackPublishOptions;
  queueSizeMs?: number;
}
export class ParticipantAudioOutput {
  private room: Room;
  private options: AudioOutputOptions;
  private audioSource: AudioSource;
  private publication?: LocalTrackPublication;
  private flushTask?: Task<void>;
  private pushedDurationMs: number = 0;
  private startedFuture: Future<void> = new Future();
  private interruptedFuture: Future<void> = new Future();

  private playbackFinishedFuture: Future<void> = new Future();
  private capturing: boolean = false;
  private playbackFinishedCount: number = 0;
  private playbackSegmentsCount: number = 0;
  private lastPlaybackEvent: PlaybackFinishedEvent = {
    playbackPosition: 0,
    interrupted: false,
  };

  private logger = log();

  constructor(room: Room, options: AudioOutputOptions) {
    this.room = room;
    this.options = options;
    this.audioSource = new AudioSource(options.sampleRate, options.numChannels);
  }

  get queueSizeMs(): number {
    return this.options.queueSizeMs ?? 100000;
  }

  async start(): Promise<void> {
    this.startedFuture = new Future();
    this.publishTrack();
    this.startedFuture.resolve();
  }

  /**
   * Capture an audio frame for playback, frames can be pushed faster than real-time
   */
  async captureFrame(frame: AudioFrame): Promise<void> {
    await this.startedFuture.await;

    if (!this.capturing) {
      this.capturing = true;
      this.playbackSegmentsCount++;
    }

    // TODO(AJS-102): use frame.durationMs once available in rtc-node
    this.pushedDurationMs += frame.samplesPerChannel / frame.sampleRate;
    await this.audioSource.captureFrame(frame);
  }

  /**
   * Wait for the past audio segments to finish playing out.
   *
   * @returns The event that was emitted when the audio finished playing out (only the last segment information)
   */
  async waitForPlayout(): Promise<PlaybackFinishedEvent> {
    const target = this.playbackSegmentsCount;

    while (this.playbackFinishedCount < target) {
      await this.playbackFinishedFuture.await;
      this.playbackFinishedFuture = new Future();
    }

    return this.lastPlaybackEvent;
  }

  private async waitForPlayoutTask(abortController: AbortController): Promise<void> {
    const abortFuture = new Future<boolean>();

    const resolveAbort = () => {
      if (!abortFuture.done) abortFuture.resolve(true);
    };

    abortController.signal.addEventListener('abort', resolveAbort);

    this.audioSource.waitForPlayout().finally(() => {
      abortController.signal.removeEventListener('abort', resolveAbort);
      if (!abortFuture.done) abortFuture.resolve(false);
    });

    const interrupted = await abortFuture.await;

    let pushedDuration = this.pushedDurationMs;

    if (interrupted) {
      // Calculate actual played duration accounting for queued audio
      pushedDuration = Math.max(this.pushedDurationMs - this.audioSource.queuedDuration, 0);
      this.audioSource.clearQueue();
    }

    this.pushedDurationMs = 0;
    this.onPlaybackFinished({
      playbackPosition: pushedDuration,
      interrupted,
      // TODO(AJS-104): implement transcript synchronization
    });
  }

  /**
   * Flush any buffered audio, marking the current playback/segment as complete
   */
  flush(): void {
    this.capturing = false;

    if (!this.pushedDurationMs) {
      return;
    }

    if (this.flushTask && !this.flushTask.done) {
      this.logger.error('flush called while playback is in progress');
      this.flushTask.cancel();
    }

    this.flushTask = Task.from((controller) => this.waitForPlayoutTask(controller));
  }

  /**
   * Clear the buffer, stopping playback immediately
   */
  clearBuffer(): void {
    if (!this.pushedDurationMs) {
      return;
    }

    this.interruptedFuture.resolve();
  }

  private onPlaybackFinished(event: PlaybackFinishedEvent) {
    this.lastPlaybackEvent = event;
    this.playbackFinishedCount++;
    this.playbackFinishedFuture.resolve();
  }

  private async publishTrack() {
    const track = LocalAudioTrack.createAudioTrack('roomio_audio', this.audioSource);
    this.publication = await this.room.localParticipant?.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
    await this.publication?.waitForSubscription();
  }
}

export class RoomIO {
  private agentSession: AgentSession;
  private participantAudioInputStream: ReadableStream<AudioFrame>;

  private room: Room;

  private _deferredAudioInputStream = new DeferredReadableStream<AudioFrame>();
  private participantAudioOutput?: ParticipantAudioOutput;
  private userTranscriptOutput?: ParalellTextOutput;
  private agentTranscriptOutput?: ParalellTextOutput;

  private participantIdentity?: string;
  private participantAvailableFuture: Future<Participant> = new Future();
  private roomConnectedFuture: Future<void> = new Future();

  private logger = log();

  constructor(
    agentSession: AgentSession,
    room: Room,
    private readonly sampleRate: number,
    private readonly numChannels: number,
  ) {
    this.agentSession = agentSession;
    this.room = room;
    this.participantAudioInputStream = this._deferredAudioInputStream.stream;
  }

  private onTrackSubscribed = (track: RemoteTrack) => {
    if (track.kind === TrackKind.KIND_AUDIO) {
      this._deferredAudioInputStream.setSource(
        new AudioStream(track, {
          // TODO(AJS-41) remove hardcoded sample rate
          sampleRate: 16000,
          numChannels: 1,
        }),
      );
    }
  };

  private async initTask() {
    await this.roomConnectedFuture.await;

    for (const participant of this.room.remoteParticipants.values()) {
      this.onParticipantConnected(participant);
    }

    const participant = await this.participantAvailableFuture.await;

    // init user outputs
    this.updateTranscriptionOutput(this.userTranscriptOutput, participant.identity);

    // init agent outputs
    this.updateTranscriptionOutput(
      this.agentTranscriptOutput,
      this.room.localParticipant?.identity,
    );

    await this.participantAudioOutput?.start();
  }

  private onParticipantConnected(participant: Participant) {
    if (this.participantAvailableFuture.done) {
      return;
    }

    if (this.participantIdentity) {
      if (participant.identity !== this.participantIdentity) {
        return;
      }
    } else if (
      // otherwise, skip participants that are marked as publishing for this agent
      participant.attributes?.[ATTRIBUTE_PUBLISH_ON_BEHALF] === this.room.localParticipant?.identity
    ) {
      return;
    }

    // TODO(shubhra): allow user to specify accepted participany kinds

    this.participantAvailableFuture.resolve(participant);
  }

  private onUserInputTranscribed = (ev: UserInputTranscribedEvent) => {
    this.logger.debug({ ev }, 'user input transcribed');
    this.userTranscriptOutput?.captureText(ev.transcript);
    if (ev.isFinal) {
      this.userTranscriptOutput?.flush();
    }
  };

  private createTranscriptionOutput(options: { isDeltaStream: boolean; participant?: string }) {
    return new ParalellTextOutput([
      new ParticipantLegacyTranscriptionOutput(
        this.room,
        options.isDeltaStream,
        options.participant,
      ),
      new ParticipantTranscriptionOutput(this.room, options.isDeltaStream, options.participant),
    ]);
  }

  private updateTranscriptionOutput(output?: ParalellTextOutput, participant?: string) {
    if (!output) {
      return;
    }

    for (const sink of output._sinks) {
      if (
        sink instanceof ParticipantLegacyTranscriptionOutput ||
        sink instanceof ParticipantTranscriptionOutput
      ) {
        sink.setParticipant(participant);
      }
    }
  }

  start() {
    // -- create outputs --
    this.participantAudioOutput = new ParticipantAudioOutput(this.room, {
      sampleRate: this.sampleRate,
      numChannels: this.numChannels,
      trackPublishOptions: new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    });

    this.userTranscriptOutput = this.createTranscriptionOutput({
      isDeltaStream: false,
      participant: this.participantIdentity,
    });
    this.agentTranscriptOutput = this.createTranscriptionOutput({
      isDeltaStream: true,
    });

    // -- set the room event handlers --
    this.room.on(RoomEvent.ParticipantConnected, this.onParticipantConnected);
    this.room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    if (this.room.isConnected) {
      this.roomConnectedFuture.resolve();
    }

    this.initTask();

    // -- attatch the agent to the session --
    this.agentSession.audioInput = this.participantAudioInputStream;
    this.agentSession.audioOutput = this.participantAudioOutput;
    this.agentSession._transcriptionOutput = this.agentTranscriptOutput;

    this.agentSession.on(AgentSessionEvent.UserInputTranscribed, this.onUserInputTranscribed);
  }
}
