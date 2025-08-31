// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioFrame,
  AudioSource,
  type LocalTrackPublication,
  type Room,
  VideoFrame,
  VideoSource,
  ConnectionState,
  LocalAudioTrack,
  LocalVideoTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { log } from '../../log.js';
import { Future, Task, cancelAndWait } from '../../utils.js';
import { AudioReceiver, AudioSegmentEnd, VideoGenerator } from './_types.js';

/**
 * Configuration options for the avatar runner
 */
export interface AvatarOptions {
  videoWidth: number;
  videoHeight: number;
  videoFps: number;
  audioSampleRate: number;
  audioChannels: number;
}

/**
 * Worker that generates synchronized avatar video based on received audio
 */
export class AvatarRunner {
  private room: Room;
  private videoGen: VideoGenerator;
  private options: AvatarOptions;
  private queueSizeMs: number;
  private lazyPublish: boolean;

  private audioRecv: AudioReceiver;
  private playbackPosition: number = 0.0;
  private audioPlaying: boolean = false;
  private tasks: Set<Task<any>> = new Set();

  private lock = Promise.resolve();
  private audioPublication?: LocalTrackPublication;
  private videoPublication?: LocalTrackPublication;
  private republishTask?: Task<void>;

  // Audio/video sources
  private audioSource: AudioSource;
  private videoSource: VideoSource;

  // Tasks
  private readAudioTask?: Task<void>;
  private forwardVideoTask?: Task<void>;
  private roomConnectedFuture: Future<void> = new Future();

  protected logger = log();

  constructor({
    room,
    audioRecv,
    videoGen,
    options,
    queueSizeMs = 100,
    lazyPublish = true,
  }: {
    room: Room;
    audioRecv: AudioReceiver;
    videoGen: VideoGenerator;
    options: AvatarOptions;
    queueSizeMs?: number;
    lazyPublish?: boolean;
  }) {
    this.room = room;
    this.audioRecv = audioRecv;
    this.videoGen = videoGen;
    this.options = options;
    this.queueSizeMs = queueSizeMs;
    this.lazyPublish = lazyPublish;

    // Create audio/video sources
    this.audioSource = new AudioSource(
      options.audioSampleRate,
      options.audioChannels,
      queueSizeMs,
    );
    this.videoSource = new VideoSource(options.videoWidth, options.videoHeight);
  }

  async start(): Promise<void> {
    // Start audio receiver
    await this.audioRecv.start();
    this.audioRecv.on('clear_buffer', this.onClearBuffer.bind(this));

    // Set up room event handlers
    this.room.on(RoomEvent.Reconnected, this.onReconnected.bind(this));
    this.room.on(RoomEvent.ConnectionStateChanged, this.onConnectionStateChanged.bind(this));
    
    if (this.room.isConnected) {
      this.roomConnectedFuture.resolve();
    }

    if (!this.lazyPublish) {
      await this.publishTracks();
    }

    // Start processing tasks
    this.readAudioTask = Task.from(() => this.readAudioTaskImpl());
    this.forwardVideoTask = Task.from(() => this.forwardVideoTaskImpl());
  }

  async waitForComplete(): Promise<void> {
    if (!this.readAudioTask || !this.forwardVideoTask) {
      throw new Error('AvatarRunner not started');
    }

    await Promise.all([
      this.readAudioTask.result,
      this.forwardVideoTask.result,
    ]);
  }

  private async publishTracks(): Promise<void> {
    // Use lock to ensure only one publish operation at a time
    this.lock = this.lock.then(async () => {
      await this.roomConnectedFuture.await;

      const localParticipant = this.room.localParticipant;
      if (!localParticipant) {
        throw new Error('Local participant not available');
      }

      // Publish audio track
      const audioTrack = LocalAudioTrack.createAudioTrack('avatar_audio', this.audioSource);
      const audioOptions = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
      this.audioPublication = await localParticipant.publishTrack(audioTrack, audioOptions);
      await this.audioPublication.waitForSubscription();

      // Publish video track
      const videoTrack = LocalVideoTrack.createVideoTrack('avatar_video', this.videoSource);
      const videoOptions = new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA });
      this.videoPublication = await localParticipant.publishTrack(videoTrack, videoOptions);
    });

    await this.lock;
  }

  private async readAudioTaskImpl(): Promise<void> {
    try {
      for await (const frame of this.audioRecv) {
        if (!this.audioPlaying && frame instanceof AudioFrame) {
          this.audioPlaying = true;
        }
        await this.videoGen.pushAudio(frame);
      }
    } catch (error) {
      this.logger.error('Error in read audio task:', error);
      throw error;
    }
  }

  private async forwardVideoTaskImpl(): Promise<void> {
    try {
      for await (const frame of this.videoGen) {
        if (frame instanceof AudioSegmentEnd) {
          // Notify the agent that the audio has finished playing
          if (this.audioPlaying) {
            const notifyResult = this.audioRecv.notifyPlaybackFinished(
              this.playbackPosition,
              false,
            );
            this.audioPlaying = false;
            this.playbackPosition = 0.0;
            
            if (notifyResult instanceof Promise) {
              // Avoid blocking the video forwarding
              const task = Task.from(() => notifyResult);
              this.tasks.add(task);
              task.result.finally(() => this.tasks.delete(task));
            }
          }
          continue;
        }

        if (!this.videoPublication) {
          await this.publishTracks();
        }

        // Push frame to appropriate source based on type
        if (frame instanceof AudioFrame) {
          await this.audioSource.captureFrame(frame);
          this.playbackPosition += frame.samplesPerChannel / frame.sampleRate;
        } else if (frame instanceof VideoFrame) {
          await this.videoSource.captureFrame(frame);
        }
      }
    } catch (error) {
      this.logger.error('Error in forward video task:', error);
      throw error;
    }
  }

  private onClearBuffer(): void {
    const handleClearBuffer = async (audioPlaying: boolean): Promise<void> => {
      try {
        const clearResult = this.videoGen.clearBuffer();
        if (clearResult instanceof Promise) {
          await clearResult;
        }

        if (audioPlaying) {
          const notifyResult = this.audioRecv.notifyPlaybackFinished(
            this.playbackPosition,
            true,
          );
          this.playbackPosition = 0.0;
          
          if (notifyResult instanceof Promise) {
            await notifyResult;
          }
        }
      } catch (error) {
        this.logger.error('Error handling clear buffer:', error);
      }
    };

    const task = Task.from(() => handleClearBuffer(this.audioPlaying));
    this.tasks.add(task);
    task.result.finally(() => this.tasks.delete(task));
    this.audioPlaying = false;
  }

  private onReconnected(): void {
    if (this.lazyPublish && !this.videoPublication) {
      return;
    }

    if (this.republishTask) {
      this.republishTask.cancel();
    }
    this.republishTask = Task.from(() => this.publishTracks());
  }

  private onConnectionStateChanged(state: ConnectionState): void {
    if (this.room.isConnected && !this.roomConnectedFuture.done) {
      this.roomConnectedFuture.resolve();
    }
  }

  async aclose(): Promise<void> {
    // Remove event handlers
    this.room.off(RoomEvent.Reconnected, this.onReconnected.bind(this));
    this.room.off(RoomEvent.ConnectionStateChanged, this.onConnectionStateChanged.bind(this));

    // Close audio receiver
    await this.audioRecv.aclose();

    // Cancel and wait for main tasks
    if (this.forwardVideoTask) {
      await this.forwardVideoTask.cancelAndWait();
    }
    if (this.readAudioTask) {
      await this.readAudioTask.cancelAndWait();
    }

    // Cancel and wait for all background tasks
    await cancelAndWait(Array.from(this.tasks));

    if (this.republishTask) {
      await this.republishTask.cancelAndWait();
    }

    // Close sources
    await this.audioSource.close();
    await this.videoSource.close();
  }
}
