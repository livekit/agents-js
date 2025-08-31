// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioFrame,
  type ByteStreamReader,
  type ByteStreamWriter,
  ConnectionState,
  ParticipantKind,
  type RemoteParticipant,
  type Room,
  RoomEvent,
  type RpcInvocationData,
  TrackKind,
  type TrackPublication,
} from '@livekit/rtc-node';
import { AudioByteStream } from '../../audio.js';
import { log } from '../../log.js';
import { AsyncIterableQueue, Future, Task, shortuuid } from '../../utils.js';
import { AudioOutput, type PlaybackFinishedEvent } from '../io.js';
import { AudioReceiver, AudioSegmentEnd } from './_types.js';

const RPC_CLEAR_BUFFER = 'lk.clear_buffer';
const RPC_PLAYBACK_FINISHED = 'lk.playback_finished';
const AUDIO_STREAM_TOPIC = 'lk.audio_stream';

/**
 * Utility function to wait for a participant to join the room
 */
async function waitForParticipant(
  room: Room,
  identity?: string,
  kind?: ParticipantKind,
): Promise<RemoteParticipant> {
  if (!room.isConnected) {
    throw new Error('room is not connected');
  }

  // Check if participant is already in the room
  for (const p of room.remoteParticipants.values()) {
    if ((!identity || p.identity === identity) && (!kind || p.info.kind === kind)) {
      return p;
    }
  }

  // Wait for participant to join
  return new Promise((resolve, reject) => {
    const onParticipantConnected = (participant: RemoteParticipant) => {
      if ((!identity || participant.identity === identity) && (!kind || participant.info.kind === kind)) {
        clearHandlers();
        resolve(participant);
      }
    };

    const onDisconnected = () => {
      clearHandlers();
      reject(new Error('Room disconnected while waiting for participant'));
    };

    const clearHandlers = () => {
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };

    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
  });
}

/**
 * Utility function to wait for a track publication
 */
async function waitForTrackPublication(
  room: Room,
  identity: string,
  kind: TrackKind,
): Promise<TrackPublication> {
  const participant = room.remoteParticipants.get(identity);
  if (!participant) {
    throw new Error(`Participant ${identity} not found`);
  }

  // Check if track is already published
  for (const pub of participant.trackPublications.values()) {
    if (pub.kind === kind) {
      return pub;
    }
  }

  // Wait for track to be published
  return new Promise((resolve, reject) => {
    const onTrackPublished = (publication: TrackPublication, p: RemoteParticipant) => {
      if (p.identity === identity && publication.kind === kind) {
        clearHandlers();
        resolve(publication);
      }
    };

    const onDisconnected = () => {
      clearHandlers();
      reject(new Error('Room disconnected while waiting for track publication'));
    };

    const clearHandlers = () => {
      room.off(RoomEvent.TrackPublished, onTrackPublished);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };

    room.on(RoomEvent.TrackPublished, onTrackPublished);
    room.on(RoomEvent.Disconnected, onDisconnected);
  });
}

/**
 * AudioOutput implementation that streams audio to a remote avatar worker using LiveKit DataStream.
 */
export class DataStreamAudioOutput extends AudioOutput {
  private static playbackFinishedHandlers: Map<string, (data: RpcInvocationData) => Promise<string>> =
    new Map();
  private static playbackFinishedRpcRegistered: boolean = false;

  private room: Room;
  private destinationIdentity: string;
  private waitRemoteTrack?: TrackKind;
  private streamWriter?: ByteStreamWriter;
  private pushedDuration: number = 0.0;
  private tasks: Set<Task<any>> = new Set();
  private started: boolean = false;
  private lock = Promise.resolve();
  private startTask?: Task<void>;
  private roomConnectedFuture: Future<void> = new Future();
  protected logger = log();

  constructor({
    room,
    destinationIdentity,
    sampleRate,
    waitRemoteTrack,
  }: {
    room: Room;
    destinationIdentity: string;
    sampleRate?: number;
    waitRemoteTrack?: TrackKind;
  }) {
    super(sampleRate);
    this.room = room;
    this.destinationIdentity = destinationIdentity;
    this.waitRemoteTrack = waitRemoteTrack;

    const onRoomConnected = () => {
      if (!this.startTask && !this.roomConnectedFuture.done) {
        // Register the RPC method right after the room is connected
        DataStreamAudioOutput.registerPlaybackFinishedRpc(
          this.room,
          this.destinationIdentity,
          this.handlePlaybackFinished.bind(this),
        );
        this.startTask = Task.from(() => this.startTaskImpl());
      }
    };

    this.roomConnectedFuture.await.then(onRoomConnected).catch(() => {
      // Ignore errors, they will be handled elsewhere
    });

    this.room.on(RoomEvent.Connected, this.handleConnectionStateChanged.bind(this));
    if (this.room.isConnected) {
      this.roomConnectedFuture.resolve();
    }
  }

  private async startTaskImpl(): Promise<void> {
    // Use lock to ensure only one start operation at a time
    this.lock = this.lock.then(async () => {
      if (this.started) {
        return;
      }

      await this.roomConnectedFuture.await;

      DataStreamAudioOutput.registerPlaybackFinishedRpc(
        this.room,
        this.destinationIdentity,
        this.handlePlaybackFinished.bind(this),
      );

      this.logger.debug('waiting for the remote participant', {
        identity: this.destinationIdentity,
      });

      await waitForParticipant(this.room, this.destinationIdentity);

      if (this.waitRemoteTrack) {
        this.logger.debug('waiting for the remote track', {
          identity: this.destinationIdentity,
          kind: this.waitRemoteTrack,
        });

        await waitForTrackPublication(this.room, this.destinationIdentity, this.waitRemoteTrack);
      }

      this.logger.debug('remote participant ready', {
        identity: this.destinationIdentity,
      });

      this.started = true;
    });

    await this.lock;
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    // Start the initialization if not already started
    if (!this.startTask) {
      this.startTask = Task.from(() => this.startTaskImpl());
    }

    // Wait for initialization to complete
    await this.startTask.result;

    await super.captureFrame(frame);

    if (!this.streamWriter) {
      const localParticipant = this.room.localParticipant;
      if (!localParticipant) {
        throw new Error('Local participant not available');
      }
      this.streamWriter = await localParticipant.streamBytes({
        name: shortuuid('AUDIO_'),
        topic: AUDIO_STREAM_TOPIC,
        destinationIdentities: [this.destinationIdentity],
        attributes: {
          sample_rate: frame.sampleRate.toString(),
          num_channels: frame.channels.toString(),
        },
      });
      this.pushedDuration = 0.0;
    }

    if (this.streamWriter) {
      await this.streamWriter.write(new Uint8Array(frame.data.buffer));
      this.pushedDuration += frame.samplesPerChannel / frame.sampleRate;
    }
  }

  flush(): void {
    if (!this.streamWriter || !this.started) {
      return;
    }

    // Close the stream marking the end of the segment
    const task = Task.from(() => this.streamWriter!.close());
    this.tasks.add(task);
    task.result.finally(() => this.tasks.delete(task));

    this.streamWriter = undefined;
  }

  clearBuffer(): void {
    if (!this.started) {
      return;
    }

    const task = Task.from(async () => {
      const localParticipant = this.room.localParticipant;
      if (localParticipant) {
        return await localParticipant.performRpc({
          destinationIdentity: this.destinationIdentity,
          method: RPC_CLEAR_BUFFER,
          payload: '',
        });
      }
      return '';
    });
    this.tasks.add(task);
    task.result.finally(() => this.tasks.delete(task));
  }

  private async handlePlaybackFinished(data: RpcInvocationData): Promise<string> {
    if (data.callerIdentity !== this.destinationIdentity) {
      this.logger.warn('playback finished event received from unexpected participant', {
        callerIdentity: data.callerIdentity,
        expectedIdentity: this.destinationIdentity,
      });
      return 'reject';
    }

    this.logger.info('playback finished event received', {
      callerIdentity: data.callerIdentity,
    });

    const event: PlaybackFinishedEvent = JSON.parse(data.payload);
    this.onPlaybackFinished({
      playbackPosition: event.playbackPosition,
      interrupted: event.interrupted,
    });
    return 'ok';
  }

  private handleConnectionStateChanged(): void {
    if (this.room.isConnected && !this.roomConnectedFuture.done) {
      this.roomConnectedFuture.resolve();
    }
  }

  private static registerPlaybackFinishedRpc(
    room: Room,
    callerIdentity: string,
    handler: (data: RpcInvocationData) => Promise<string>,
  ): void {
    this.playbackFinishedHandlers.set(callerIdentity, handler);

    if (this.playbackFinishedRpcRegistered) {
      return;
    }

    const rpcHandler = async (data: RpcInvocationData): Promise<string> => {
      const handler = this.playbackFinishedHandlers.get(data.callerIdentity);
      if (!handler) {
        log().warn('playback finished event received from unexpected participant', {
          callerIdentity: data.callerIdentity,
          expectedIdentities: Array.from(this.playbackFinishedHandlers.keys()),
        });
        return 'reject';
      }
      return await handler(data);
    };

    room.localParticipant?.registerRpcMethod(RPC_PLAYBACK_FINISHED, rpcHandler);
    this.playbackFinishedRpcRegistered = true;
  }
}

/**
 * Audio receiver that receives streamed audio from a sender participant using LiveKit DataStream.
 * If the sender_identity is provided, subscribe to the specified participant. If not provided,
 * subscribe to the first agent participant in the room.
 */
export class DataStreamAudioReceiver extends AudioReceiver {
  private static clearBufferRpcRegistered: boolean = false;
  private static clearBufferHandlers: Map<string, (data: RpcInvocationData) => Promise<string>> =
    new Map();

  private room: Room;
  private senderIdentity?: string;
  private remoteParticipant?: RemoteParticipant;
  private frameSizeMs: number;
  private rpcMaxRetries: number;

  private streamReaders: ByteStreamReader[] = [];
  private streamReaderChanged: Future<void> = new Future();
  private dataChannel = new AsyncIterableQueue<AudioFrame | AudioSegmentEnd>();

  private currentReader?: ByteStreamReader;
  private currentReaderCleared: boolean = false;

  private playbackFinishedChannel = new AsyncIterableQueue<PlaybackFinishedEvent>();

  private mainTask?: Task<void>;
  private exception?: Error;
  private closing: boolean = false;
  protected logger = log();

  constructor({
    room,
    senderIdentity,
    frameSizeMs = 100,
    rpcMaxRetries = 3,
  }: {
    room: Room;
    senderIdentity?: string;
    frameSizeMs?: number;
    rpcMaxRetries?: number;
  }) {
    super();
    this.room = room;
    this.senderIdentity = senderIdentity;
    this.frameSizeMs = frameSizeMs;
    this.rpcMaxRetries = rpcMaxRetries;
  }

  async start(): Promise<void> {
    // Wait for the target participant or first agent participant to join
    this.remoteParticipant = await waitForParticipant(
      this.room,
      this.senderIdentity,
      this.senderIdentity ? undefined : ParticipantKind.AGENT,
    );

    this.mainTask = Task.from(() => this.mainTaskImpl());

    const handleClearBuffer = async (data: RpcInvocationData): Promise<string> => {
      if (!this.remoteParticipant) {
        return 'reject';
      }

      if (data.callerIdentity !== this.remoteParticipant.identity) {
        this.logger.warn('clear buffer event received from unexpected participant', {
          callerIdentity: data.callerIdentity,
          expectedIdentity: this.remoteParticipant.identity,
        });
        return 'reject';
      }

      if (this.currentReader) {
        this.currentReaderCleared = true;
      }
      this.emit('clear_buffer');
      return 'ok';
    };

    const handleStreamReceived = (reader: ByteStreamReader, participantInfo: { identity: string }) => {
      if (!this.remoteParticipant || participantInfo.identity !== this.remoteParticipant.identity) {
        return;
      }

      this.streamReaders.push(reader);
      if (!this.streamReaderChanged.done) {
        this.streamReaderChanged.resolve();
        this.streamReaderChanged = new Future();
      }
    };

    DataStreamAudioReceiver.registerClearBufferRpc(
      this.room,
      this.remoteParticipant.identity,
      handleClearBuffer,
    );

    this.room.registerByteStreamHandler(AUDIO_STREAM_TOPIC, handleStreamReceived);
  }

  notifyPlaybackFinished(playbackPosition: number, interrupted: boolean): void {
    this.playbackFinishedChannel.put({
      playbackPosition,
      interrupted,
    });
  }

  private async mainTaskImpl(): Promise<void> {
    const tasks = [
      Task.from(() => this.recvTask()),
      Task.from(() => this.sendTask()),
    ];

    try {
      await Promise.all(tasks.map(task => task.result));
    } catch (error) {
      this.exception = error as Error;
    } finally {
      this.playbackFinishedChannel.close();
      this.dataChannel.close();
      // Cancel remaining tasks
      await Promise.all(tasks.map(task => task.cancelAndWait()));
    }
  }

  private async sendTask(): Promise<void> {
    try {
      for await (const event of this.playbackFinishedChannel) {
        if (!this.remoteParticipant) {
          continue;
        }

        let retryCount = 0;
        while (retryCount < this.rpcMaxRetries) {
          this.logger.debug(
            `notifying playback finished: ${event.playbackPosition.toFixed(3)}s, ` +
            `interrupted: ${event.interrupted}`,
          );

          try {
            const localParticipant = this.room.localParticipant;
            if (localParticipant) {
              await localParticipant.performRpc({
                destinationIdentity: this.remoteParticipant.identity,
                method: RPC_PLAYBACK_FINISHED,
                payload: JSON.stringify(event),
              });
            }
            break;
          } catch (error) {
            if (retryCount === this.rpcMaxRetries - 1) {
              this.logger.error(
                `failed to notify playback finished after ${retryCount + 1} retries`,
                error,
              );
              throw error;
            }
            retryCount++;
            this.logger.warn('failed to notify the agent playback finished, retrying...');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    } catch (error) {
      if (!this.closing) {
        this.logger.error('Error in send task:', error);
      }
    }
  }

  private async recvTask(): Promise<void> {
    try {
      while (!this.dataChannel.closed) {
        await this.streamReaderChanged.await;

        while (this.streamReaders.length > 0) {
          this.currentReader = this.streamReaders.shift()!;

          const attrs = this.currentReader.info.attributes;
          if (!attrs || !attrs['sample_rate'] || !attrs['num_channels']) {
            throw new Error('sample_rate or num_channels not found in byte stream');
          }

          const sampleRate = parseInt(attrs['sample_rate']);
          const numChannels = parseInt(attrs['num_channels']);
          const samplesPerChannel = Math.ceil(sampleRate * this.frameSizeMs / 1000);
          
          const bstream = new AudioByteStream(sampleRate, numChannels, samplesPerChannel);

          try {
            for await (const data of this.currentReader) {
              if (this.currentReaderCleared) {
                // Ignore the rest of the data if clear_buffer was called
                break;
              }
              
              const frames = bstream.write(data);
              for (const frame of frames) {
                this.dataChannel.put(frame);
              }
            }

            if (!this.currentReaderCleared) {
              const frames = bstream.flush();
              for (const frame of frames) {
                this.dataChannel.put(frame);
              }
            }

            this.currentReader = undefined;
            this.currentReaderCleared = false;
            this.dataChannel.put(new AudioSegmentEnd());

          } catch (error) {
            if (this.closing) {
              return;
            }
            throw error;
          }
        }

        this.streamReaderChanged = new Future();
      }
    } catch (error) {
      if (!this.closing) {
        this.logger.error('Error in recv task:', error);
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AudioFrame | AudioSegmentEnd> {
    try {
      for await (const item of this.dataChannel) {
        yield item;
      }
    } catch (error) {
      if (this.exception) {
        throw this.exception;
      }
      throw error;
    }
  }

  async aclose(): Promise<void> {
    this.closing = true;
    this.playbackFinishedChannel.close();
    this.dataChannel.close();
    
    if (!this.streamReaderChanged.done) {
      this.streamReaderChanged.resolve();
    }
    
    if (this.mainTask) {
      await this.mainTask.cancelAndWait();
    }
  }

  private static registerClearBufferRpc(
    room: Room,
    callerIdentity: string,
    handler: (data: RpcInvocationData) => Promise<string>,
  ): void {
    this.clearBufferHandlers.set(callerIdentity, handler);

    if (this.clearBufferRpcRegistered) {
      return;
    }

    const rpcHandler = async (data: RpcInvocationData): Promise<string> => {
      const handler = this.clearBufferHandlers.get(data.callerIdentity);
      if (!handler) {
        log().warn('clear buffer event received from unexpected participant', {
          callerIdentity: data.callerIdentity,
          expectedIdentities: Array.from(this.clearBufferHandlers.keys()),
        });
        return 'reject';
      }
      return await handler(data);
    };

    room.localParticipant?.registerRpcMethod(RPC_CLEAR_BUFFER, rpcHandler);
    this.clearBufferRpcRegistered = true;
  }
}
