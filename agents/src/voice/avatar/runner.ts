
import type { Room, LocalTrackPublication } from '@livekit/rtc-node';
import { ConnectionState, AudioSource, VideoSource, LocalAudioTrack, TrackSource, LocalVideoTrack, RoomEvent, TrackPublishOptions } from '@livekit/rtc-node';
import { AudioReceiver, VideoGenerator, AudioSegmentEnd } from './types.js';
import { log } from '../../log.js';

export interface AvatarOptions {
  videoWidth: number;
  videoHeight: number;
  videoFps: number;
  audioSampleRate: number;
  audioChannels: number;
}

class AVSynchronizer {
  constructor(options: { audio_source: any, video_source: any, video_fps: any, video_queue_size_ms: any}) { 
    // TODO: Implement AVSynchronizer
  }
  async push(frame: any) {}
  async aclose() {}
}

export class AvatarRunner {
  private readonly room: Room;

  private readonly videoGen: VideoGenerator;

  private readonly options: AvatarOptions;

  private readonly queueSizeMs: number;

  private readonly audioRecv: AudioReceiver;

  private playbackPosition = 0;

  private audioPlaying = false;

  private tasks: Set<Promise<any>> = new Set();

  private audioPublication?: LocalTrackPublication;

  private videoPublication?: LocalTrackPublication;

  private republishPromise?: Promise<void>;

  private readonly lazyPublish: boolean;

  private readonly audioSource: AudioSource;

  private readonly videoSource: VideoSource;

  private readonly avSync: AVSynchronizer;

  private forwardVideoPromise?: Promise<void>;

  private readAudioPromise?: Promise<void>;

  constructor(
    room: Room,
    audioRecv: AudioReceiver,
    videoGen: VideoGenerator,
    options: AvatarOptions,
    queueSizeMs = 100,
    lazyPublish = true,
  ) {
    this.room = room;
    this.audioRecv = audioRecv;
    this.videoGen = videoGen;
    this.options = options;
    this.queueSizeMs = queueSizeMs;
    this.lazyPublish = lazyPublish;

    this.audioSource = new AudioSource(
      options.audioSampleRate,
      options.audioChannels,
    );


    this.videoSource = new VideoSource(
      options.videoWidth,
      options.videoHeight,
    );

    this.avSync = new AVSynchronizer({
      audio_source: this.audioSource,
      video_source: this.videoSource,
      video_fps: options.videoFps,
      video_queue_size_ms: this.queueSizeMs,
    });
  }

  get avSynchronizer(): AVSynchronizer {
    return this.avSync;
  }

  async start(): Promise<void> {
    await this.audioRecv.start();
    this.audioRecv.on('clear_buffer', this.onClearBuffer);

    this.room.on(RoomEvent.Reconnected, this.onReconnected);

    if (!this.lazyPublish) {
      await this.publishTrack();
    }

    this.readAudioPromise = this.readAudio();
    this.forwardVideoPromise = this.forwardVideo();
  }

  async waitForComplete(): Promise<void> {
    if (!this.readAudioPromise || !this.forwardVideoPromise) {
      throw new Error('AvatarRunner not started');
    }

    await Promise.all([this.readAudioPromise, this.forwardVideoPromise]);
  }

  private async publishTrack(): Promise<void> {
    // Wait for room to be connected
    if (this.room.connectionState !== ConnectionState.CONN_CONNECTED) {
      await new Promise<void>((resolve) => {
        const onConnected = () => {
          this.room.off(RoomEvent.ConnectionStateChanged, onConnected);
          resolve();
        };
        this.room.on(RoomEvent.ConnectionStateChanged, onConnected);
      });
    }

    const audioTrack = LocalAudioTrack.createAudioTrack('avatar_audio', this.audioSource);
    const audioOptions = new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
    });
    this.audioPublication = await this.room.localParticipant!.publishTrack(audioTrack, audioOptions);

    const videoTrack = LocalVideoTrack.createVideoTrack('avatar_video', this.videoSource);
    const videoOptions = new TrackPublishOptions({
      source: TrackSource.SOURCE_CAMERA,
    });
    this.videoPublication = await this.room.localParticipant!.publishTrack(videoTrack, videoOptions);
  }

  private async readAudio(): Promise<void> {
    for await (const frame of this.audioRecv) {
      if (!this.audioPlaying && !(frame instanceof AudioSegmentEnd)) {
        this.audioPlaying = true;
      }
      await this.videoGen.pushAudio(frame);
    }
  }

  private async forwardVideo(): Promise<void> {
    for await (const frame of this.videoGen) {
      if (frame instanceof AudioSegmentEnd) {
        if (this.audioPlaying) {
          const task = this.audioRecv.notifyPlaybackFinished(
            this.playbackPosition,
            false,
          ) as Promise<void>;
          this.audioPlaying = false;
          this.playbackPosition = 0;
          if (task) {
            this.tasks.add(task);
            task.then(() => this.tasks.delete(task));
          }
        }
        continue;
      }

      if (!this.videoPublication) {
        await this.publishTrack();
      }

      await this.avSync.push(frame);
      if (!(frame instanceof AudioSegmentEnd)) {
        // this.playbackPosition += frame.duration;
      }
    }
  }

  private onClearBuffer = () => {
    const task = (async (audioPlaying: boolean) => {
      const clearTask = this.videoGen.clearBuffer();
      if (clearTask) {
        await clearTask;
      }

      if (audioPlaying) {
        const notifyTask = this.audioRecv.notifyPlaybackFinished(
          this.playbackPosition,
          true,
        ) as Promise<void>;
        this.playbackPosition = 0;
        if (notifyTask) {
          await notifyTask;
        }
      }
    })(this.audioPlaying);

    this.tasks.add(task);
    task.then(() => this.tasks.delete(task));
    this.audioPlaying = false;
  };

  private onReconnected = () => {
    if (this.lazyPublish && !this.videoPublication) {
      return;
    }

    if (this.republishPromise) {
      // TODO: cancel previous promise
    }
    this.republishPromise = this.publishTrack();
  };

  async aclose(): Promise<void> {
    this.room.off(RoomEvent.Reconnected, this.onReconnected);
    this.audioRecv.removeListener('clear_buffer', this.onClearBuffer);

    await this.audioRecv.aclose();
    if (this.forwardVideoPromise) {
      // TODO: cancel promise
    }
    if (this.readAudioPromise) {
      // TODO: cancel promise
    }

    await Promise.all(Array.from(this.tasks));

    if (this.republishPromise) {
      // TODO: cancel promise
    }

    await this.avSync.aclose();
  }
}
