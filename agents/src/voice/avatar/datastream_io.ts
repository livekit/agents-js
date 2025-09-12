// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import {
  type AudioFrame,
  type ByteStreamWriter,
  type Room,
  RoomEvent,
  type RpcInvocationData,
  type TrackKind,
} from '@livekit/rtc-node';
import { log } from '../../log.js';
import {
  Future,
  Task,
  shortuuid,
  waitForParticipant,
  waitForTrackPublication,
} from '../../utils.js';
import { AudioOutput, type PlaybackFinishedEvent } from '../io.js';

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

  private room: Room;
  private destinationIdentity: string;
  private roomConnectedFuture: Future<void>;
  private waitRemoteTrack?: TrackKind;
  private streamWriter?: ByteStreamWriter;
  private pushedDuration: number = 0;
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

  private async _start(_abortSignal: AbortSignal) {
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

  async captureFrame(frame: AudioFrame): Promise<void> {
    if (!this.startTask) {
      this.startTask = Task.from(({ signal }) => this._start(signal));
    }

    await this.startTask.result;
    await super.captureFrame(frame);

    if (!this.streamWriter) {
      this.streamWriter = await this.room.localParticipant!.streamBytes({
        name: shortuuid('AUDIO_'),
        topic: AUDIO_STREAM_TOPIC,
        destinationIdentities: [this.destinationIdentity],
        attributes: {
          sample_rate: frame.sampleRate.toString(),
          num_channels: frame.channels.toString(),
        },
      });
      this.pushedDuration = 0;
    }

    // frame.data is a Int16Array, write accepts a Uint8Array
    await this.streamWriter.write(new Uint8Array(frame.data.buffer));
    this.pushedDuration += frame.samplesPerChannel / frame.sampleRate;
  }

  flush(): void {
    super.flush();

    if (this.streamWriter === undefined || !this.started) {
      return;
    }

    this.streamWriter.close().finally(() => {
      this.streamWriter = undefined;
    });
  }

  clearBuffer(): void {
    if (!this.started) return;

    this.room.localParticipant!.performRpc({
      destinationIdentity: this.destinationIdentity,
      method: RPC_CLEAR_BUFFER,
      payload: '',
    });
  }

  private handlePlaybackFinished(data: RpcInvocationData): string {
    if (data.callerIdentity !== this.destinationIdentity) {
      this.#logger.warn(
        {
          callerIdentity: data.callerIdentity,
          destinationIdentity: this.destinationIdentity,
        },
        'playback finished event received from unexpected participant',
      );
      return 'reject';
    }

    this.#logger.info(
      {
        callerIdentity: data.callerIdentity,
      },
      'playback finished event received',
    );

    const playbackFinishedEvent = JSON.parse(data.payload) as PlaybackFinishedEvent;
    this.onPlaybackFinished(playbackFinishedEvent);
    return 'ok';
  }

  static registerPlaybackFinishedRpc({
    room,
    callerIdentity,
    handler,
  }: {
    room: Room;
    callerIdentity: string;
    handler: (data: RpcInvocationData) => string;
  }) {
    DataStreamAudioOutput._playbackFinishedHandlers[callerIdentity] = handler;

    if (DataStreamAudioOutput._playbackFinishedRpcRegistered) {
      return;
    }

    const rpcHandler = async (data: RpcInvocationData): Promise<string> => {
      const handler = DataStreamAudioOutput._playbackFinishedHandlers[data.callerIdentity];
      if (!handler) {
        log().warn(
          {
            callerIdentity: data.callerIdentity,
            expectedIdentities: Object.keys(DataStreamAudioOutput._playbackFinishedHandlers),
          },
          'playback finished event received from unexpected participant',
        );

        return 'reject';
      }
      return handler(data);
    };

    room.localParticipant?.registerRpcMethod(RPC_PLAYBACK_FINISHED, rpcHandler);
    DataStreamAudioOutput._playbackFinishedRpcRegistered = true;
  }
}
