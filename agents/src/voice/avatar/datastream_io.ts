import { Mutex } from '@livekit/mutex';
import {
  ByteStreamWriter,
  Room,
  RoomEvent,
  type RpcInvocationData,
  TrackKind,
} from '@livekit/rtc-node';
import { Future, Task } from 'agents/src/utils.js';
import { AudioOutput } from '../io.js';

export interface DataStreamAudioOutputOptions {
  room: Room;
  destinationIdentity: string;
  sampleRate?: number;
  waitRemoteTrack?: TrackKind;
}

export class DataStreamAudioOutput extends AudioOutput {
  private room: Room;
  private destinationIdentity: string;
  private started: boolean;
  private lock: Lock;
  private startTask: Task<void>;
  private roomConnectedFuture: Future<void>;

  private sampleRate?: number;
  private waitRemoteTrack?: TrackKind;
  private streamWriter?: ByteStreamWriter;
  private pushedDuration: number = 0;
  private tasks: Set<Task<void>> = new Set();
  private started: boolean = false;
  private lock = new Mutex();
  private startTask?: Task<void>;

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

  private async _start(abortSignal: AbortSignal) {}

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
