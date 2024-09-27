// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { type AudioSource } from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import { AudioByteStream } from '../audio.js';
import type { TranscriptionForwarder } from '../transcription.js';
import type { Queue } from '../utils.js';

export const proto = {};

export class AgentPlayout {
  #audioSource: AudioSource;
  #playoutPromise: Promise<void> | null;
  #sampleRate: number;
  #numChannels: number;
  #inFrameSize: number;
  #outFrameSize: number;
  constructor(
    audioSource: AudioSource,
    sampleRate: number,
    numChannels: number,
    inFrameSize: number,
    outFrameSize: number,
  ) {
    this.#audioSource = audioSource;
    this.#playoutPromise = null;
    this.#sampleRate = sampleRate;
    this.#numChannels = numChannels;
    this.#inFrameSize = inFrameSize;
    this.#outFrameSize = outFrameSize;
  }

  play(
    itemId: string,
    contentIndex: number,
    transcriptionFwd: TranscriptionForwarder,
    textStream: Queue<string | null>,
    audioStream: Queue<AudioFrame | null>,
  ): PlayoutHandle {
    const handle = new PlayoutHandle(
      this.#audioSource,
      this.#sampleRate,
      itemId,
      contentIndex,
      transcriptionFwd,
    );
    this.#playoutPromise = this.#playoutTask(this.#playoutPromise, handle, textStream, audioStream);
    return handle;
  }

  async #playoutTask(
    oldPromise: Promise<void> | null,
    handle: PlayoutHandle,
    textStream: Queue<string | null>,
    audioStream: Queue<AudioFrame | null>,
  ): Promise<void> {
    if (oldPromise) {
      // TODO: cancel old task
      // oldPromise.cancel();
    }

    let firstFrame = true;

    const playTextStream = async () => {
      while (true) {
        const text = await textStream.get();
        if (text === null) break;
        handle.transcriptionFwd.pushText(text);
      }
      handle.transcriptionFwd.markTextComplete();
    };

    const captureTask = async () => {
      const samplesPerChannel = this.#outFrameSize;
      const bstream = new AudioByteStream(this.#sampleRate, this.#numChannels, samplesPerChannel);

      while (true) {
        const frame = await audioStream.get();
        if (frame === null) break;

        if (firstFrame) {
          handle.transcriptionFwd.start();
          firstFrame = false;
        }

        handle.transcriptionFwd.pushAudio(frame);

        for (const f of bstream.write(frame.data.buffer)) {
          handle.pushedDuration += f.samplesPerChannel / f.sampleRate;
          await this.#audioSource.captureFrame(f);
        }
      }

      for (const f of bstream.flush()) {
        handle.pushedDuration += f.samplesPerChannel / f.sampleRate;
        await this.#audioSource.captureFrame(f);
      }

      handle.transcriptionFwd.markAudioComplete();

      await this.#audioSource.waitForPlayout();
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const readTextTaskPromise = playTextStream();
    const captureTaskPromise = captureTask();

    try {
      await Promise.race([captureTaskPromise, handle.intPromise]);
    } finally {
      // TODO: cancel tasks
      // if (!captureTaskPromise.isCancelled) {
      //   captureTaskPromise.cancel();
      // }

      handle.totalPlayedTime = handle.pushedDuration - this.#audioSource.queuedDuration;

      // TODO: handle errors
      // if (handle.interrupted || captureTaskPromise.error) {
      //   this.#audioSource.clearQueue(); // make sure to remove any queued frames
      // }

      // TODO: cancel tasks
      // if (!readTextTask.isCancelled) {
      //   readTextTask.cancel();
      // }

      if (!firstFrame && !handle.interrupted) {
        handle.transcriptionFwd.markTextComplete();
      }

      handle.emit('done');
      await handle.transcriptionFwd.close(handle.interrupted);
    }
  }
}

export class PlayoutHandle extends EventEmitter {
  #audioSource: AudioSource;
  #sampleRate: number;
  #itemId: string;
  #contentIndex: number;
  /** @internal */
  transcriptionFwd: TranscriptionForwarder;
  #donePromiseResolved: boolean;
  /** @internal */
  donePromise: Promise<void>;
  #intPromiseResolved: boolean;
  /** @internal */
  intPromise: Promise<void>;
  #interrupted: boolean;
  /** @internal */
  pushedDuration: number;
  /** @internal */
  totalPlayedTime: number | undefined; // Set when playout is done

  constructor(
    audioSource: AudioSource,
    sampleRate: number,
    itemId: string,
    contentIndex: number,
    transcriptionFwd: TranscriptionForwarder,
  ) {
    super();
    this.#audioSource = audioSource;
    this.#sampleRate = sampleRate;
    this.#itemId = itemId;
    this.#contentIndex = contentIndex;
    this.transcriptionFwd = transcriptionFwd;
    this.#donePromiseResolved = false;
    this.donePromise = new Promise((resolve) => {
      this.once('done', () => {
        this.#donePromiseResolved = true;
        resolve();
      });
    });
    this.#intPromiseResolved = false;
    this.intPromise = new Promise((resolve) => {
      this.once('interrupt', () => {
        this.#intPromiseResolved = true;
        resolve();
      });
    });
    this.#interrupted = false;
    this.pushedDuration = 0;
    this.totalPlayedTime = undefined;
  }

  get itemId(): string {
    return this.#itemId;
  }

  get audioSamples(): number {
    if (this.totalPlayedTime !== undefined) {
      return Math.floor(this.totalPlayedTime * this.#sampleRate);
    }

    return Math.floor(this.pushedDuration - this.#audioSource.queuedDuration * this.#sampleRate);
  }

  get textChars(): number {
    return this.transcriptionFwd.currentCharacterIndex; // TODO: length of played text
  }

  get contentIndex(): number {
    return this.#contentIndex;
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  get done(): boolean {
    return this.#donePromiseResolved || this.#interrupted;
  }

  interrupt() {
    if (this.#donePromiseResolved) return;
    this.#interrupted = true;
    this.emit('interrupt');
  }
}
