
import type { AudioFrame } from '@livekit/rtc-node';
import { AudioOutput } from '../io.js';
import { AudioReceiver, AudioSegmentEnd } from './types.js';
import { Chan } from '../../utils/chans.js';

export class QueueAudioOutput extends AudioOutput implements AudioReceiver {
  private readonly dataCh: Chan<AudioFrame | AudioSegmentEnd>;

  private capturing = false;

  constructor(sampleRate?: number) {
    super(sampleRate);
    this.dataCh = new Chan();
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (!this.capturing) {
      this.capturing = true;
    }

    await this.dataCh.send(frame);
  }

  flush(): void {
    super.flush();
    if (!this.capturing) {
      return;
    }
    this.capturing = false;
    this.dataCh.trySend(new AudioSegmentEnd());
  }

  // as AudioReceiver for AvatarRunner

  clearBuffer(): void {
    while (true) {
      const item = this.dataCh.tryRecv();
      if (item.done) {
        break;
      }
    }
    this.emit('clear_buffer');
  }

  notifyPlaybackFinished(playbackPosition: number, interrupted: boolean): void {
    this.onPlaybackFinished({
      playbackPosition,
      interrupted,
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<AudioFrame | AudioSegmentEnd> {
    return this.dataCh[Symbol.asyncIterator]();
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  aclose(): Promise<void> {
    this.dataCh.close();
    return Promise.resolve();
  }
}
