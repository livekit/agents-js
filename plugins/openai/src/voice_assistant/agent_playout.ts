import { AudioByteStream } from '@livekit/agents';
import { AudioFrame, type AudioSource } from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import * as proto from './proto.js';
import type { TranscriptionForwarder } from './transcription_forwarder';

export class PlayoutHandle {
  private messageId: string;
  transcriptionFwd: TranscriptionForwarder;
  audioSamples: number;
  done: boolean;
  interrupted: boolean;
  playoutQueue: EventEmitter;

  constructor(messageId: string, transcriptionFwd: TranscriptionForwarder) {
    this.messageId = messageId;
    this.transcriptionFwd = transcriptionFwd;
    this.audioSamples = 0;
    this.done = false;
    this.interrupted = false;
    this.playoutQueue = new EventEmitter();
  }

  pushAudio(data: Uint8Array) {
    const frame = new AudioFrame(
      new Int16Array(data.buffer),
      proto.SAMPLE_RATE,
      proto.NUM_CHANNELS,
      data.length / 2,
    );
    this.transcriptionFwd.pushAudio(frame);
    this.playoutQueue.emit('frame', frame);
  }

  pushText(text: string) {
    this.transcriptionFwd.pushText(text);
  }

  endInput() {
    // this.transcriptionFwd.markTextSegmentEnd();
    // this.transcriptionFwd.markAudioSegmentEnd();
    this.playoutQueue.emit('end');
  }

  interrupt() {
    if (this.done) return;
    this.interrupted = true;
  }
}

export class AgentPlayout {
  private audioSource: AudioSource;
  private currentPlayoutTask: Promise<void> | null;

  constructor(audioSource: AudioSource) {
    this.audioSource = audioSource;
    this.currentPlayoutTask = null;
  }

  play(messageId: string, transcriptionFwd: TranscriptionForwarder): PlayoutHandle {
    const handle = new PlayoutHandle(messageId, transcriptionFwd);
    this.currentPlayoutTask = this.playoutTask(this.currentPlayoutTask, handle);
    return handle;
  }

  private async playoutTask(oldTask: Promise<void> | null, handle: PlayoutHandle): Promise<void> {
    if (oldTask) {
      await this.gracefullyCancel(oldTask);
    }

    let firstFrame = true;

    try {
      const bstream = new AudioByteStream(
        proto.SAMPLE_RATE,
        proto.NUM_CHANNELS,
        proto.OUTPUT_PCM_FRAME_SIZE,
      );

      handle.playoutQueue.on('frame', async (frame: AudioFrame) => {
        if (firstFrame) {
          //   handle.transcriptionFwd.segmentPlayoutStarted();
          firstFrame = false;
        }

        for (const f of bstream.write(frame.data.buffer)) {
          handle.audioSamples += f.samplesPerChannel;
          if (handle.interrupted) break;

          await this.audioSource.captureFrame(f);
        }
      });

      await new Promise<void>((resolve) => {
        handle.playoutQueue.on('end', resolve);
      });

      if (!handle.interrupted) {
        for (const f of bstream.flush()) {
          await this.audioSource.captureFrame(f);
        }
      }
    } finally {
      if (!firstFrame && !handle.interrupted) {
        // handle.transcriptionFwd.segmentPlayoutFinished();
      }
      await handle.transcriptionFwd.close();
      handle.done = true;
    }
  }

  private async gracefullyCancel(task: Promise<void>): Promise<void> {
    // Implementation of graceful cancellation
  }
}
