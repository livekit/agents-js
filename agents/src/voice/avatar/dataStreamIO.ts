import { AudioFrame, ConnectionState, RoomEvent, TrackKind } from '@livekit/rtc-node';
import type { Room, RemoteTrack } from '@livekit/rtc-node';
import { AudioOutput, type PlaybackFinishedEvent } from '../io.js';
import { AudioReceiver, AudioSegmentEnd } from './types.js';
import { Chan } from '../../utils/chans.js';
import { shortuuid } from '../../utils/shortuuid.js';
import { log } from '../../log.js';
import { waitForParticipant, waitForTrackPublication } from '../../utils/participant.js';

const RPC_CLEAR_BUFFER = 'lk.clear_buffer';
const RPC_PLAYBACK_FINISHED = 'lk.playback_finished';
const AUDIO_STREAM_TOPIC = 'lk.audio_stream';

export class DataStreamAudioOutput extends AudioOutput {
  private static playbackFinishedRpcRegistered = false;

  private static playbackFinishedHandlers: Map<string, (data: string) => string> = new Map();

  private readonly room: Room;

  private readonly destinationIdentity: string;

  private readonly waitRemoteTrack?: TrackKind;

  private streamWriter?: WritableStreamDefaultWriter<Uint8Array>;

  private pushedDuration = 0;

  private tasks: Set<Promise<any>> = new Set();

  private started = false;

  private startPromise: Promise<void> | undefined;

  constructor(room: Room, destinationIdentity: string, sampleRate?: number) {
    super(sampleRate);
    this.room = room;
    this.destinationIdentity = destinationIdentity;

    this.room.on(RoomEvent.Connected, this.handleConnectionStateChanged);
    if (this.room.isConnected) {
      this.handleConnectionStateChanged();
    }
  }

  private async startTask(): Promise<void> {
    if (this.started) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = (async () => {
        // Room should already be connected, but ensure it is
        if (!this.room.isConnected) {
          throw new Error('Room must be connected before starting DataStreamAudioOutput');
        }

        DataStreamAudioOutput.registerPlaybackFinishedRpc(
          this.room,
          this.destinationIdentity,
          this.handlePlaybackFinished.bind(this),
        );

        log().debug(`waiting for the remote participant ${this.destinationIdentity}`);
        await waitForParticipant(this.room, this.destinationIdentity);

        if (this.waitRemoteTrack) {
          log().debug(
            `waiting for the remote track ${this.destinationIdentity} ${this.waitRemoteTrack}`,
          );
          await waitForTrackPublication(this.room, this.destinationIdentity);
        }

        log().debug(`remote participant ready ${this.destinationIdentity}`);
        this.started = true;
      })();
    }

    await this.startPromise;
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.startTask();
    }

    await this.startPromise;
    await super.captureFrame(frame);

    if (!this.streamWriter) {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      this.streamWriter = stream.writable.getWriter();
      
      // Convert stream to Uint8Array by reading chunks
      const chunks: Uint8Array[] = [];
      const reader = stream.readable.getReader();
      
      // Create a readable stream from the transform stream
      const dataStream = new ReadableStream({
        start(controller) {
          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  break;
                }
                controller.enqueue(value);
              }
            } catch (error) {
              controller.error(error);
            }
          };
          pump();
        }
      });

      // Get the data as Uint8Array chunks for publishing
      const dataReader = dataStream.getReader();
      const publishData = async () => {
        try {
          while (true) {
            const { done, value } = await dataReader.read();
            if (done) break;
            
                         await this.room.localParticipant!.publishData(value, {
               topic: AUDIO_STREAM_TOPIC,
               destination_identities: [this.destinationIdentity],
             });
          }
        } catch (error) {
          log().error('Error publishing data stream:', error);
        }
      };
      
      // Start publishing in background
      publishData();
      this.pushedDuration = 0;
    }

    await this.streamWriter.write(new Uint8Array(frame.data));
    this.pushedDuration += frame.data.byteLength / frame.sampleRate / frame.channels / 2;
  }

  flush(): void {
    super.flush();
    if (!this.streamWriter || !this.started) {
      return;
    }

    const task = this.streamWriter.close();
    this.tasks.add(task);
    task.then(() => this.tasks.delete(task));

    this.streamWriter = undefined;
  }

  clearBuffer(): void {
    if (!this.started) {
      return;
    }

    const task = this.room.localParticipant!.performRpc({
      method: RPC_CLEAR_BUFFER,
      payload: '',
      destinationIdentity: this.destinationIdentity,
    });
    this.tasks.add(task);
    task.then(() => this.tasks.delete(task)).catch(() => this.tasks.delete(task));
  }

  // Remove resume() and pause() methods as they don't exist in base class

  private handlePlaybackFinished(data: string): string {
    log().info(`playback finished event received from ${this.destinationIdentity}`);

    const event = JSON.parse(data) as PlaybackFinishedEvent;
    this.onPlaybackFinished(event);
    return 'ok';
  }

  private handleConnectionStateChanged = () => {
    if (this.room.isConnected && !this.startPromise) {
      this.startPromise = this.startTask();
    }
  };

  private static registerPlaybackFinishedRpc(
    room: Room,
    callerIdentity: string,
    handler: (data: string) => string,
  ) {
    this.playbackFinishedHandlers.set(callerIdentity, handler);

    if (this.playbackFinishedRpcRegistered) {
      return;
    }

    room.localParticipant!.registerRpcMethod(RPC_PLAYBACK_FINISHED, async (data: any) => {
      const handler = this.playbackFinishedHandlers.get(data.callerIdentity);
      if (!handler) {
        log().warn(
          `playback finished event received from unexpected participant ${data.callerIdentity}`,
        );
        return 'reject';
      }
      return handler(data.payload as string);
    });

    this.playbackFinishedRpcRegistered = true;
  }
}

export class DataStreamAudioReceiver extends AudioReceiver {
  private static clearBufferRpcRegistered = false;

  private static clearBufferHandlers: Map<string, (data: string, ctx: any) => string> = new Map();

  private readonly room: Room;

  private readonly senderIdentity?: string;

  private readonly frameSizeMs: number;

  private readonly rpcMaxRetries: number;

  private remoteParticipant?: import('@livekit/rtc-node').RemoteParticipant;

  private streamReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];

  private streamReaderChanged: Chan<void> = new Chan(1);

  private dataCh: Chan<AudioFrame | AudioSegmentEnd> = new Chan();

  private currentReader?: ReadableStreamDefaultReader<Uint8Array>;

  private currentReaderCleared = false;

  private playbackFinishedCh: Chan<PlaybackFinishedEvent> = new Chan();

  private mainPromise?: Promise<void>;

  private exception?: Error;

  private closing = false;

  constructor(
    room: Room,
    senderIdentity?: string,
    frameSizeMs: number = 100,
    rpcMaxRetries: number = 3,
  ) {
    super();
    this.room = room;
    this.senderIdentity = senderIdentity;
    this.frameSizeMs = frameSizeMs;
    this.rpcMaxRetries = rpcMaxRetries;
  }

  async start(): Promise<void> {
    this.remoteParticipant = await waitForParticipant(this.room, this.senderIdentity, {
      kind: this.senderIdentity ? undefined : 'agent',
    });

    this.mainPromise = this.mainTask();

    const handleClearBuffer = (data: string, ctx: any) => {
      if (ctx.from.identity !== this.remoteParticipant?.identity) {
        log().warn(
          `clear buffer event received from unexpected participant ${ctx.from.identity}`,
        );
        return 'reject';
      }

      if (this.currentReader) {
        this.currentReaderCleared = true;
      }
      this.emit('clear_buffer');
      return 'ok';
    };

    DataStreamAudioReceiver.registerClearBufferRpc(
      this.room,
      this.remoteParticipant!.identity,
      handleClearBuffer,
    );

    this.room.on(RoomEvent.TrackSubscribed, (track, _, participant) => {
      if (
        participant.identity === this.remoteParticipant?.identity &&
        track.kind === TrackKind.KIND_AUDIO // Use correct enum value
      ) {
        // Handle audio tracks for data streaming
        // Note: This may need adjustment based on actual data track implementation
        log().debug(`Audio track subscribed from ${participant.identity}`);
      }
    });

    // Register byte stream handler for audio data
    this.room.registerByteStreamHandler(AUDIO_STREAM_TOPIC, async (reader, { identity }) => {
      if (identity === this.remoteParticipant?.identity) {
        // Convert ByteStreamReader to ReadableStreamDefaultReader
        const chunks = await reader.readAll() as Uint8Array[];
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          }
        });
        this.streamReaders.push(stream.getReader());
        this.streamReaderChanged.trySend();
      }
    });
  }

  notifyPlaybackFinished(playbackPosition: number, interrupted: boolean): void {
    this.playbackFinishedCh.trySend({ playbackPosition, interrupted });
  }

  private async mainTask(): Promise<void> {
    const tasks = [this.recvTask(), this.sendTask()];
    try {
      await Promise.all(tasks);
    } catch (error) {
      this.exception = error as Error;
    } finally {
      this.playbackFinishedCh.close();
      this.dataCh.close();
    }
  }

  private async sendTask(): Promise<void> {
    for await (const event of this.playbackFinishedCh) {
      if (!this.remoteParticipant) {
        continue;
      }

      let retryCount = 0;
      while (retryCount < this.rpcMaxRetries) {
        log().debug(
          `notifying playback finished: ${event.playbackPosition.toFixed(3)}s, interrupted: ${
            event.interrupted
          }`,
        );
        try {
          await this.room.localParticipant!.performRpc({
            method: RPC_PLAYBACK_FINISHED,
            payload: JSON.stringify(event),
            destinationIdentity: this.remoteParticipant.identity,
          });
          break;
        } catch (e) {
          if (retryCount === this.rpcMaxRetries - 1) {
            log().error(`failed to notify playback finished after ${retryCount + 1} retries`, e);
            throw e;
          }
          retryCount++;
          log().warn('failed to notify the agent playback finished, retrying...');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  }

  private async recvTask(): Promise<void> {
    while (!this.dataCh.isClosed) {
      await this.streamReaderChanged.recv();

      while (this.streamReaders.length > 0) {
        this.currentReader = this.streamReaders.shift();
        if (!this.currentReader) {
          continue;
        }

        // TODO: Get attributes from the stream
        const sampleRate = 48000;
        const numChannels = 1;
        const bstream = new AudioByteStream(
          sampleRate,
          numChannels,
          Math.ceil((sampleRate * this.frameSizeMs) / 1000),
        );

        try {
          while (true) {
            const result = await this.currentReader.read();
            if (result.done) {
              break;
            }

            if (this.currentReaderCleared) {
              break;
            }

            for (const frame of bstream.push(result.value)) {
              this.dataCh.trySend(frame);
            }
          }

          if (!this.currentReaderCleared) {
            for (const frame of bstream.flush()) {
              this.dataCh.trySend(frame);
            }
          }

          this.currentReader = undefined;
          this.currentReaderCleared = false;
          this.dataCh.trySend(new AudioSegmentEnd());
        } catch (e) {
          if (this.closing) {
            return;
          }
          throw e;
        }
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AudioFrame | AudioSegmentEnd> {
    return this.dataCh[Symbol.asyncIterator]();
  }

  async aclose(): Promise<void> {
    this.closing = true;
    this.playbackFinishedCh.close();
    this.dataCh.close();
    this.streamReaderChanged.trySend();
    if (this.mainPromise) {
      await this.mainPromise;
    }
  }

  private static registerClearBufferRpc(
    room: Room,
    callerIdentity: string,
    handler: (data: string, context: any) => string,
  ) {
    this.clearBufferHandlers.set(callerIdentity, handler);

    if (this.clearBufferRpcRegistered) {
      return;
    }

    room.localParticipant!.registerRpcMethod(RPC_CLEAR_BUFFER, async (data: any) => {
      const handler = this.clearBufferHandlers.get(data.callerIdentity);
      if (!handler) {
        log().warn(`clear buffer event received from unexpected participant ${data.callerIdentity}`);
        return 'reject';
      }
      return handler(data.payload as string, data);
    });

    this.clearBufferRpcRegistered = true;
  }
}

// Helper class to convert byte stream to audio frames
class AudioByteStream {
  private readonly sampleRate: number;

  private readonly numChannels: number;

  private readonly samplesPerChannel: number;

  private buffer: Uint8Array = new Uint8Array();

  constructor(sampleRate: number, numChannels: number, samplesPerChannel: number) {
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;
    this.samplesPerChannel = samplesPerChannel;
  }

  push(data: Uint8Array): AudioFrame[] {
    const newBuffer = new Uint8Array(this.buffer.length + data.length);
    newBuffer.set(this.buffer);
    newBuffer.set(data, this.buffer.length);
    this.buffer = newBuffer;

    const frames: AudioFrame[] = [];
    const frameSize = this.samplesPerChannel * this.numChannels * 2;

    while (this.buffer.length >= frameSize) {
      const frameData = this.buffer.slice(0, frameSize);
      this.buffer = this.buffer.slice(frameSize);

      const frame = new AudioFrame(
        new Int16Array(frameData.buffer),
        this.sampleRate,
        this.numChannels,
        this.samplesPerChannel
      );
      frames.push(frame);
    }

    return frames;
  }

  flush(): AudioFrame[] {
    if (this.buffer.length > 0) {
      const frameData = new Uint8Array(this.samplesPerChannel * this.numChannels * 2);
      frameData.set(this.buffer);
      const frame = new AudioFrame(
        new Int16Array(frameData.buffer),
        this.sampleRate,
        this.numChannels,
        this.samplesPerChannel
      );
      this.buffer = new Uint8Array();
      return [frame];
    }
    return [];
  }
}
