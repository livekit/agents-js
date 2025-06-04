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
import { log } from '../log.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import type { AgentSession } from './agent_session.js';

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
        }) as ReadableStream<AudioFrame>,
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
