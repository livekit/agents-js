// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { type AudioSource } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { AudioByteStream } from '../audio.js';
import type { TranscriptionForwarder } from '../transcription.js';
import { type AsyncIterableQueue, CancellablePromise, Future, gracefullyCancel } from '../utils.js';

export const proto = {};

export class PlayoutHandle extends EventEmitter {
  #audioSource: AudioSource;
  #sampleRate: number;
  #itemId: string;
  #contentIndex: number;
  /** @internal */
  transcriptionFwd: TranscriptionForwarder;
  /** @internal */
  doneFut: Future;
  /** @internal */
  intFut: Future;
  /** @internal */
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
    this.doneFut = new Future();
    this.intFut = new Future();
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

    return Math.floor(
      (this.pushedDuration - this.#audioSource.queuedDuration) * (this.#sampleRate / 1000),
    );
  }

  get textChars(): number {
    return this.transcriptionFwd.currentCharacterIndex;
  }

  get contentIndex(): number {
    return this.#contentIndex;
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  get done(): boolean {
    return this.doneFut.done || this.#interrupted;
  }

  interrupt() {
    if (this.doneFut.done) return;
    this.intFut.resolve();
    this.#interrupted = true;
  }
}

export class AgentPlayout extends EventEmitter {
  #audioSource: AudioSource;
  #playoutTask: CancellablePromise<void> | null;
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
    super();
    this.#audioSource = audioSource;
    this.#playoutTask = null;
    this.#sampleRate = sampleRate;
    this.#numChannels = numChannels;
    this.#inFrameSize = inFrameSize;
    this.#outFrameSize = outFrameSize;
  }

  play(
    itemId: string,
    contentIndex: number,
    transcriptionFwd: TranscriptionForwarder,
    textStream: AsyncIterableQueue<string>,
    audioStream: AsyncIterableQueue<AudioFrame>,
  ): PlayoutHandle {
    const handle = new PlayoutHandle(
      this.#audioSource,
      this.#sampleRate,
      itemId,
      contentIndex,
      transcriptionFwd,
    );
    this.#playoutTask = this.#makePlayoutTask(this.#playoutTask, handle, textStream, audioStream);
    return handle;
  }

  #makePlayoutTask(
    oldTask: CancellablePromise<void> | null,
    handle: PlayoutHandle,
    textStream: AsyncIterableQueue<string>,
    audioStream: AsyncIterableQueue<AudioFrame>,
  ): CancellablePromise<void> {
    return new CancellablePromise<void>((resolve, reject, onCancel) => {
      let cancelled = false;
      onCancel(() => {
        cancelled = true;
      });

      (async () => {
        try {
          if (oldTask) {
            await gracefullyCancel(oldTask);
          }

          let firstFrame = true;

          const readText = () =>
            new CancellablePromise<void>((resolveText, rejectText, onCancelText) => {
              let cancelledText = false;
              onCancelText(() => {
                cancelledText = true;
              });

              (async () => {
                try {
                  for await (const text of textStream) {
                    if (cancelledText || cancelled) {
                      break;
                    }
                    handle.transcriptionFwd.pushText(text);
                  }
                  resolveText();
                } catch (error) {
                  rejectText(error);
                }
              })();
            });

          const capture = () =>
            new CancellablePromise<void>((resolveCapture, rejectCapture, onCancelCapture) => {
              let cancelledCapture = false;
              onCancelCapture(() => {
                cancelledCapture = true;
              });

              (async () => {
                try {
                  const samplesPerChannel = this.#outFrameSize;
                  const bstream = new AudioByteStream(
                    this.#sampleRate,
                    this.#numChannels,
                    samplesPerChannel,
                  );

                  for await (const frame of audioStream) {
                    if (cancelledCapture || cancelled) {
                      break;
                    }
                    if (firstFrame) {
                      handle.transcriptionFwd.start();
                      this.emit('playout_started');
                      firstFrame = false;
                    }

                    handle.transcriptionFwd.pushAudio(frame);

                    for (const f of bstream.write(frame.data.buffer)) {
                      handle.pushedDuration += (f.samplesPerChannel / f.sampleRate) * 1000;
                      await this.#audioSource.captureFrame(f);
                    }
                  }

                  if (!cancelledCapture && !cancelled) {
                    for (const f of bstream.flush()) {
                      handle.pushedDuration += (f.samplesPerChannel / f.sampleRate) * 1000;
                      await this.#audioSource.captureFrame(f);
                    }

                    handle.transcriptionFwd.markAudioComplete();

                    await this.#audioSource.waitForPlayout();
                  }

                  resolveCapture();
                } catch (error) {
                  rejectCapture(error);
                }
              })();
            });

          const readTextTask = readText();
          const captureTask = capture();

          try {
            await Promise.race([captureTask, handle.intFut.await]);
          } finally {
            if (!captureTask.isCancelled) {
              await gracefullyCancel(captureTask);
            }

            handle.totalPlayedTime = handle.pushedDuration - this.#audioSource.queuedDuration;

            if (handle.interrupted || captureTask.error) {
              this.#audioSource.clearQueue(); // make sure to remove any queued frames
            }

            if (!readTextTask.isCancelled) {
              await gracefullyCancel(readTextTask);
            }

            if (!firstFrame) {
              if (!handle.interrupted) {
                handle.transcriptionFwd.markTextComplete();
              }

              this.emit('playout_stopped', handle.interrupted);
            }

            handle.doneFut.resolve();
            await handle.transcriptionFwd.close(handle.interrupted);
          }

          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    });
  }
}
