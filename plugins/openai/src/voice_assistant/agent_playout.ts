// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream } from '@livekit/agents';
import { Queue } from '@livekit/agents';
import { AudioFrame, type AudioSource } from '@livekit/rtc-node';
import * as proto from './proto.js';
import type { TranscriptionForwarder } from './transcription_forwarder';

export class PlayoutHandle {
  messageId: string;
  transcriptionFwd: TranscriptionForwarder;
  playedAudioSamples: number;
  done: boolean;
  interrupted: boolean;
  playoutQueue: Queue<AudioFrame | null>;

  constructor(messageId: string, transcriptionFwd: TranscriptionForwarder) {
    this.messageId = messageId;
    this.transcriptionFwd = transcriptionFwd;
    this.playedAudioSamples = 0;
    this.done = false;
    this.interrupted = false;
    this.playoutQueue = new Queue<AudioFrame | null>();
  }

  pushAudio(data: Uint8Array) {
    const frame = new AudioFrame(
      new Int16Array(data.buffer),
      proto.SAMPLE_RATE,
      proto.NUM_CHANNELS,
      data.length / 2,
    );
    this.transcriptionFwd.pushAudio(frame);
    this.playoutQueue.put(frame);
  }

  pushText(text: string) {
    this.transcriptionFwd.pushText(text);
  }

  endInput() {
    this.transcriptionFwd.markAudioFinished();
    this.transcriptionFwd.markTextFinished();
    this.playoutQueue.put(null);
  }

  interrupt() {
    if (this.done) return;
    this.interrupted = true;
  }

  publishedTextChars(): number {
    return this.transcriptionFwd.publishedChars;
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

      while (!handle.interrupted) {
        const frame = await handle.playoutQueue.get();
        if (frame === null) break;
        if (firstFrame) {
          handle.transcriptionFwd.start();
          firstFrame = false;
        }

        for (const f of bstream.write(frame.data.buffer)) {
          handle.playedAudioSamples += f.samplesPerChannel;
          if (handle.interrupted) break;

          await this.audioSource.captureFrame(f);
        }
      }

      if (!handle.interrupted) {
        for (const f of bstream.flush()) {
          await this.audioSource.captureFrame(f);
        }
      }
    } finally {
      if (!firstFrame && !handle.interrupted) {
        handle.transcriptionFwd.markTextFinished();
      }
      await handle.transcriptionFwd.close();
      handle.done = true;
    }
  }

  private async gracefullyCancel(task: Promise<void>): Promise<void> {
    // Implementation of graceful cancellation
  }
}
