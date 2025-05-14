// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import { AudioStream, type RemoteTrack, RoomEvent, TrackKind } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { DeferredReadableStream } from '../deferred_stream.js';
import { log } from '../log.js';
import type { AgentSession } from './agent_session.js';

export class RoomIO {
  private agentSession: AgentSession;
  private participantAudioInputStream: ReadableStream<AudioFrame>;
  private logger = log();

  private room: Room;

  private _deferredAudioInputStream = new DeferredReadableStream<AudioFrame>();

  constructor(agentSession: AgentSession, room: Room) {
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
          sampleRate: 16000,
          numChannels: 1,
        }),
      );
    }
  };

  start() {
    this.agentSession.audioInput = this.participantAudioInputStream;
  }
}
