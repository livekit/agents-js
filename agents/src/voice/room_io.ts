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
import { Future } from '../utils.js';
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
  agentSession: AgentSession;
}
export class ParticipantAudioOutput {
  private room: Room;
  private options: AudioOutputOptions;
  private audioSource: AudioSource;
  private startedFuture: Future<void>;

  private publication?: LocalTrackPublication;
  private capturing: boolean = false;
  private playbackSegmentsCount: number = 0;

  constructor(room: Room, options: AudioOutputOptions) {
    this.room = room;
    this.options = options;
    this.audioSource = new AudioSource(options.sampleRate, options.numChannels);
    this.startedFuture = new Future();
  }

  get queueSizeMs(): number {
    return this.options.queueSizeMs ?? 100000;
  }

  async start(): Promise<void> {
    this.startedFuture = new Future();
    this.publishTrack();
    this.startedFuture.resolve();
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await this.startedFuture.await;

    if (!this.capturing) {
      this.capturing = true;
      this.playbackSegmentsCount++;
    }
    // TODO(shubhra)
    this.pushedDuration += frame.duration;
    await this.audioSource.captureFrame(frame);
  }

  flush(): void {
    this.capturing = false;
    this.playbackSegmentsCount++;
    return;
  }

  clearBuffer(): void {}

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
  private audioSource?: AudioSource;
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

  private cleanup() {
    this.room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
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

  private async publishTrack(audioSource: AudioSource) {
    const track = LocalAudioTrack.createAudioTrack('roomio_audio', audioSource);
    this.publication = await this.room.localParticipant?.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
  }

  start() {
    this.audioSource = new AudioSource(this.sampleRate, this.numChannels);
    this.publishTrack(this.audioSource);
    this.agentSession.audioInput = this.participantAudioInputStream;
    this.agentSession.audioOutput = this.audioSource;
  }
}
