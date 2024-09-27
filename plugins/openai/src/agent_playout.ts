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
  #audioSource: AudioSource;
  #itemId: string;
  #contentIndex: number;
  #transcriptionFwd: TranscriptionForwarder;
  #done: boolean;
  #donePromise: Promise<void>;
  #intPromise: Promise<void>;
  #interrupted: boolean;
  #pushedDuration: number;
  #totalPlayedTime: number | undefined; // Set when playout is done

  constructor(
    audioSource: AudioSource,
    itemId: string,
    contentIndex: number,
    transcriptionFwd: TranscriptionForwarder,
  ) {
    super();
    this.#audioSource = audioSource;
    this.#itemId = itemId;
    this.#contentIndex = contentIndex;
    this.#transcriptionFwd = transcriptionFwd;
    this.#done = false;
    this.#donePromise = new Promise((resolve) => {
      this.once('done', () => {
        this.#done = true;
        resolve();
      });
    });
    this.#intPromise = new Promise((resolve) => {
      this.once('interrupt', () => {
        this.#interrupted = true;
        resolve();
      });
    });
    this.#interrupted = false;
    this.#pushedDuration = 0;
    this.#totalPlayedTime = undefined;
  }

  get itemId(): string {
    return this.#itemId;
  }

  get audioSamples(): number {
    if (this.#totalPlayedTime !== undefined) {
      return Math.floor(this.#totalPlayedTime * 24000);
    }

    // TODO: this is wrong, we need to get the actual duration from the audio source
    return Math.floor((this.#pushedDuration/* - this.#audioSource.queuedDuration*/) * 24000);
  }

  get textChars(): number {
    return this.#transcriptionFwd.currentCharacterIndex; // TODO: length of played text
  }

  get contentIndex(): number {
    return this.#contentIndex;
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  done() {
    return this.#done || this.#interrupted;
  }

  interrupt() {
    if (this.#done) return;
    this.emit('interrupt');
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
