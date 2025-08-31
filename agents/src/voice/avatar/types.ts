
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'events';

export class AudioSegmentEnd {}

export abstract class AudioReceiver extends EventEmitter {
  constructor() {
    super();
  }

  abstract start(): Promise<void>;

  abstract notifyPlaybackFinished(
    playbackPosition: number,
    interrupted: boolean,
  ): void | Promise<void>;

  abstract [Symbol.asyncIterator](): AsyncIterator<AudioFrame | AudioSegmentEnd>;

  abstract aclose(): Promise<void>;
}

export abstract class VideoGenerator {
  abstract pushAudio(frame: AudioFrame | AudioSegmentEnd): Promise<void>;

  abstract clearBuffer(): void | Promise<void>;

  abstract [Symbol.asyncIterator](): AsyncIterator<
    VideoFrame | AudioFrame | AudioSegmentEnd
  >;
}
