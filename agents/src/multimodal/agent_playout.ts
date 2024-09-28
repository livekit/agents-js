// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { type AudioSource } from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import { AudioByteStream } from '../audio.js';
import type { TranscriptionForwarder } from '../transcription.js';
import { CancellablePromise, type Queue } from '../utils.js';

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

    const playTextStream = () =>
      new CancellablePromise<void>((resolve, reject, onCancel) => {
        let cancelled = false;
        onCancel(() => {
          cancelled = true;
        });

        (async () => {
          try {
            while (!cancelled) {
              const text = await textStream.get();
              if (text === null) break;
              handle.transcriptionFwd.pushText(text);
            }
            if (!cancelled) {
              handle.transcriptionFwd.markTextComplete();
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        })();
      });

    const capture = () =>
      new CancellablePromise<void>((resolve, reject, onCancel) => {
        let cancelled = false;
        onCancel(() => {
          cancelled = true;
        });

        (async () => {
          try {
            const samplesPerChannel = this.#outFrameSize;
            const bstream = new AudioByteStream(
              this.#sampleRate,
              this.#numChannels,
              samplesPerChannel,
            );

            while (!cancelled) {
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

            if (!cancelled) {
              for (const f of bstream.flush()) {
                handle.pushedDuration += f.samplesPerChannel / f.sampleRate;
                await this.#audioSource.captureFrame(f);
              }

              handle.transcriptionFwd.markAudioComplete();

              await this.#audioSource.waitForPlayout();
            }

            resolve();
          } catch (error) {
            reject(error);
          }
        })();
      });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const playTextTask = playTextStream();
    const captureTask = capture();

    try {
      await Promise.race([captureTask, handle.intPromise]);
    } finally {
      if (!captureTask.isCancelled) {
        captureTask.cancel();
      }

      handle.totalPlayedTime = handle.pushedDuration - this.#audioSource.queuedDuration;

      if (handle.interrupted || captureTask.error) {
        this.#audioSource.clearQueue(); // make sure to remove any queued frames
      }

      if (!playTextTask.isCancelled) {
        playTextTask.cancel();
      }

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
