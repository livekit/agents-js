// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  type LocalTrackPublication,
  type RemoteTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { log } from '../log.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { Future, Task } from '../utils.js';
import type { AgentSession } from './agent_session.js';

export interface PlaybackFinishedEvent {
  // How much of the audio was played back
  playbackPosition: number;
  // Interrupted is True if playback was interrupted (clearBuffer() was called)
  interrupted: boolean;
  // Transcript synced with playback; may be partial if the audio was interrupted
  // When null, the transcript is not synchronized with the playback
  synchronizedTranscript: string | null;
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
    synchronizedTranscript: null,
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

    // TODO(shubhra): use frame.durationMs once available in rtc-node
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
    const interrupted = await new Promise<boolean>((resolve) => {
      const abortHandler = () => resolve(true);
      abortController.signal.addEventListener('abort', abortHandler);

      this.audioSource
        .waitForPlayout()
        .then(() => {
          abortController.signal.removeEventListener('abort', abortHandler);
          resolve(false);
        })
        .catch(() => {
          abortController.signal.removeEventListener('abort', abortHandler);
          resolve(false);
        });
    });

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
      synchronizedTranscript: null, // TODO: implement transcript synchronization
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
  private logger = log();

  private room: Room;

  private _deferredAudioInputStream = new DeferredReadableStream<AudioFrame>();
  private participantAudioOutput?: ParticipantAudioOutput;
  private publication?: LocalTrackPublication;

  constructor(
    agentSession: AgentSession,
    room: Room,
    private readonly sampleRate: number,
    private readonly numChannels: number,
  ) {
    this.agentSession = agentSession;
    this.room = room;
    this.participantAudioInputStream = this._deferredAudioInputStream.stream;

    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
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

  start() {
    this.participantAudioOutput = new ParticipantAudioOutput(this.room, {
      sampleRate: this.sampleRate,
      numChannels: this.numChannels,
      trackPublishOptions: new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    });
    this.participantAudioOutput.start();
    this.agentSession.audioInput = this.participantAudioInputStream;
    this.agentSession.audioOutput = this.participantAudioOutput;
  }
}
