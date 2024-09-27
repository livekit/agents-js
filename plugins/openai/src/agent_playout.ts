// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream } from '@livekit/agents';
import type { TranscriptionForwarder } from '@livekit/agents';
import type { Queue } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type AudioSource } from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import { NUM_CHANNELS, OUTPUT_PCM_FRAME_SIZE, SAMPLE_RATE } from './realtime/api_proto.js';

export class AgentPlayout {
  #audioSource: AudioSource;
  #currentPlayoutHandle: PlayoutHandle | null;
  #currentPlayoutTask: Promise<void> | null;

  constructor(audioSource: AudioSource) {
    this.#audioSource = audioSource;
    this.#currentPlayoutHandle = null;
    this.#currentPlayoutTask = null;
  }

  play(
    messageId: string,
    transcriptionFwd: TranscriptionForwarder,
    playoutQueue: Queue<AudioFrame | null>,
  ): PlayoutHandle {
    if (this.#currentPlayoutHandle) {
      this.#currentPlayoutHandle.interrupt();
    }
    this.#currentPlayoutHandle = new PlayoutHandle(messageId, transcriptionFwd, playoutQueue);
    this.#currentPlayoutTask = this.playoutTask(
      this.#currentPlayoutTask,
      this.#currentPlayoutHandle,
    );
    return this.#currentPlayoutHandle;
  }

  private async playoutTask(oldTask: Promise<void> | null, handle: PlayoutHandle): Promise<void> {
    let firstFrame = true;
    try {
      const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, OUTPUT_PCM_FRAME_SIZE);

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

          await this.#audioSource.captureFrame(f);
        }
      }

      if (!handle.interrupted) {
        for (const f of bstream.flush()) {
          await this.#audioSource.captureFrame(f);
        }
      }
    } finally {
      if (!firstFrame && !handle.interrupted) {
        handle.transcriptionFwd.markTextComplete();
      }
      await handle.transcriptionFwd.close(handle.interrupted);
      handle.complete();
    }
  }
}

export class PlayoutHandle extends EventEmitter {
  messageId: string;
  transcriptionFwd: TranscriptionForwarder;
  playedAudioSamples: number;
  done: boolean;
  interrupted: boolean;
  playoutQueue: Queue<AudioFrame | null>;

  constructor(
    messageId: string,
    transcriptionFwd: TranscriptionForwarder,
    playoutQueue: Queue<AudioFrame | null>,
  ) {
    super();
    this.messageId = messageId;
    this.transcriptionFwd = transcriptionFwd;
    this.playedAudioSamples = 0;
    this.done = false;
    this.interrupted = false;
    this.playoutQueue = playoutQueue;
  }

  // pushAudio(data: Uint8Array) {
  //   const frame = new AudioFrame(
  //     new Int16Array(data.buffer),
  //     SAMPLE_RATE,
  //     NUM_CHANNELS,
  //     data.length / 2,
  //   );
  //   this.transcriptionFwd.pushAudio(frame);
  //   this.playoutQueue.put(frame);
  // }

  // pushText(text: string) {
  //   this.transcriptionFwd.pushText(text);
  // }

  endInput() {
    this.transcriptionFwd.markAudioComplete();
    this.transcriptionFwd.markTextComplete();
    this.playoutQueue.put(null);
  }

  interrupt() {
    if (this.done) return;
    this.interrupted = true;
  }

  publishedTextChars(): number {
    return this.transcriptionFwd.currentCharacterIndex;
  }

  complete() {
    if (this.done) return;
    this.done = true;
    this.emit('complete', this.interrupted);
  }
}

// # livekit-agents/livekit/agents/omni_assistant/agent_playout.py

// class PlayoutHandle:
//     def __init__(self, *, audio_source: rtc.AudioSource, item_id: str, content_index: int, transcription_fwd: transcription.TTSSegmentsForwarder) -> None

//     @property
//     def item_id(self) -> str

//     @property
//     def audio_samples(self) -> int

//     @property
//     def text_chars(self) -> int

//     @property
//     def content_index(self) -> int

//     @property
//     def interrupted(self) -> bool

//     def done(self) -> bool

//     def interrupt(self) -> None

// class AgentPlayout:
//     def __init__(self, *, audio_source: rtc.AudioSource) -> None

//     def play(self, *, item_id: str, content_index: int, transcription_fwd: transcription.TTSSegmentsForwarder, text_stream: AsyncIterable[str], audio_stream: AsyncIterable[rtc.AudioFrame]) -> PlayoutHandle
