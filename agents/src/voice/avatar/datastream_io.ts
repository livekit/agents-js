// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import {
  AudioFrame,
  ByteStreamWriter,
  Room,
  RoomEvent,
  type RpcInvocationData,
  TrackKind,
} from '@livekit/rtc-node';
import { log } from 'agents/src/log.js';
import { Future, Task, waitForParticipant, waitForTrackPublication } from 'agents/src/utils.js';
import { AudioOutput } from '../io.js';

const RPC_CLEAR_BUFFER = 'lk.clear_buffer';
const RPC_PLAYBACK_FINISHED = 'lk.playback_finished';
const AUDIO_STREAM_TOPIC = 'lk.audio_stream';

export interface DataStreamAudioOutputOptions {
  room: Room;
  destinationIdentity: string;
  sampleRate?: number;
  waitRemoteTrack?: TrackKind;
}

/**
 * AudioOutput implementation that streams audio to a remote avatar worker using LiveKit DataStream.
 */
export class DataStreamAudioOutput extends AudioOutput {
  static _playbackFinishedRpcRegistered: boolean = false;
  static _playbackFinishedHandlers: Record<string, (data: RpcInvocationData) => string> = {};

  readonly sampleRate?: number;

  private room: Room;
  private destinationIdentity: string;
  private roomConnectedFuture: Future<void>;
  private waitRemoteTrack?: TrackKind;
  private streamWriter?: ByteStreamWriter;
  private pushedDuration: number = 0;
  private tasks: Set<Task<void>> = new Set();
  private started: boolean = false;
  private lock = new Mutex();
  private startTask?: Task<void>;

  #logger = log();

  constructor(opts: DataStreamAudioOutputOptions) {
    super(opts.sampleRate, undefined);

    const { room, destinationIdentity, sampleRate, waitRemoteTrack } = opts;
    this.room = room;
    this.destinationIdentity = destinationIdentity;
    this.sampleRate = sampleRate;
    this.waitRemoteTrack = waitRemoteTrack;

    const onRoomConnected = async () => {
      if (this.startTask) return;

      await this.roomConnectedFuture.await;

      // register the rpc method right after the room is connected
      DataStreamAudioOutput.registerPlaybackFinishedRpc({
        room,
        callerIdentity: this.destinationIdentity,
        handler: (data) => this.handlePlaybackFinished(data),
      });

      this.startTask = Task.from(({ signal }) => this._start(signal));
    };

    this.roomConnectedFuture = new Future<void>();

    this.room.on(RoomEvent.ConnectionStateChanged, (_) => {
      if (room.isConnected && !this.roomConnectedFuture.done) {
        this.roomConnectedFuture.resolve(undefined);
      }
    });

    if (this.room.isConnected) {
      this.roomConnectedFuture.resolve(undefined);
    }

    onRoomConnected();
  }

  private async _start(abortSignal: AbortSignal) {
    const unlock = await this.lock.lock();

    try {
      if (this.started) return;

      await this.roomConnectedFuture.await;

      this.#logger.debug(
        {
          identity: this.destinationIdentity,
        },
        'waiting for the remote participant',
      );

      await waitForParticipant({
        room: this.room,
        identity: this.destinationIdentity,
      });

      if (this.waitRemoteTrack) {
        this.#logger.debug(
          {
            identity: this.destinationIdentity,
            kind: this.waitRemoteTrack,
          },
          'waiting for the remote track',
        );

        await waitForTrackPublication({
          room: this.room,
          identity: this.destinationIdentity,
          kind: this.waitRemoteTrack,
        });
      }

      this.#logger.debug(
        {
          identity: this.destinationIdentity,
        },
        'remote participant ready',
      );

      this.started = true;
    } finally {
      unlock();
    }
  }

  captureFrame(_frame: AudioFrame): Promise<void> {
    return Promise.resolve();
  }

  flush(): void {
    return;
  }

  clearBuffer(): void {
    return;
  }

  private handlePlaybackFinished(data: RpcInvocationData): string {
    return '';
  }

  static registerPlaybackFinishedRpc({
    room,
    callerIdentity,
    handler,
  }: {
    room: Room;
    callerIdentity: string;
    handler: (data: RpcInvocationData) => string;
  }) {}
}
