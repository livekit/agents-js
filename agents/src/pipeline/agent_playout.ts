// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, AudioSource } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import EventEmitter from 'node:events';
import { log } from '../log.js';
import { CancellablePromise, Future, gracefullyCancel } from '../utils.js';
import { SynthesisHandle } from './agent_output.js';

export enum AgentPlayoutEvent {
  PLAYOUT_STARTED,
  PLAYOUT_STOPPED,
}

export type AgentPlayoutCallbacks = {
  [AgentPlayoutEvent.PLAYOUT_STARTED]: () => void;
  [AgentPlayoutEvent.PLAYOUT_STOPPED]: (interrupt: boolean) => void;
};

export class PlayoutHandle {
  #speechId: string;
  #audioSource: AudioSource;
  playoutSource: AsyncIterable<AudioFrame | typeof SynthesisHandle.FLUSH_SENTINEL>;
  totalPlayedTime?: number;
  #interrupted = false;
  pushedDuration = 0;
  intFut = new Future();
  doneFut = new Future();

  constructor(
    speechId: string,
    audioSource: AudioSource,
    playoutSource: AsyncIterable<AudioFrame | typeof SynthesisHandle.FLUSH_SENTINEL>,
  ) {
    this.#speechId = speechId;
    this.#audioSource = audioSource;
    this.playoutSource = playoutSource;
  }

  get speechId(): string {
    return this.#speechId;
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  get timePlayed(): number {
    return this.totalPlayedTime || this.pushedDuration - this.#audioSource.queuedDuration;
  }

  get done(): boolean {
    return this.doneFut.done || this.#interrupted;
  }

  interrupt() {
    if (this.done) {
      return;
    }

    this.intFut.resolve();
    this.#interrupted = true;
  }

  join(): Future {
    return this.doneFut;
  }
}

export class AgentPlayout extends (EventEmitter as new () => TypedEmitter<AgentPlayoutCallbacks>) {
  #closed = false;
  #audioSource: AudioSource;
  #targetVolume = 1;
  #playoutTask?: CancellablePromise<void>;
  #logger = log();

  constructor(audioSource: AudioSource) {
    super();
    this.#audioSource = audioSource;
  }

  get targetVolume(): number {
    return this.#targetVolume;
  }

  set targetVolume(vol: number) {
    this.#targetVolume = vol;
  }

  play(
    speechId: string,
    playoutSource: AsyncIterable<AudioFrame | typeof SynthesisHandle.FLUSH_SENTINEL>,
  ): PlayoutHandle {
    if (this.#closed) {
      throw new Error('source closed');
    }

    const handle = new PlayoutHandle(speechId, this.#audioSource, playoutSource);

    this.#playoutTask = this.#playout(handle, this.#playoutTask);
    return handle;
  }

  #playout(handle: PlayoutHandle, oldTask?: CancellablePromise<void>): CancellablePromise<void> {
    return new CancellablePromise(async (resolve, _, onCancel) => {
      const cancel = () => {
        captureTask.cancel();
        handle.totalPlayedTime = handle.pushedDuration - this.#audioSource.queuedDuration;

        if (handle.interrupted || captureTask.error) {
          this.#audioSource.clearQueue(); // make sure to remove any queued frames
        }

        if (!firstFrame) {
          this.emit(AgentPlayoutEvent.PLAYOUT_STOPPED, handle.interrupted);
        }

        handle.doneFut.resolve();

        this.#logger
          .child({ speechId: handle.speechId, interrupted: handle.interrupted })
          .debug('playout finished');
      };

      onCancel(() => {
        cancel();
      });

      if (oldTask) {
        await gracefullyCancel(oldTask);
      }

      if (this.#audioSource.queuedDuration > 0) {
        // this should not happen, but log it just in case
        this.#logger
          .child({ speechId: handle.speechId, queuedDuration: this.#audioSource.queuedDuration })
          .warn('new playout while the source is still playing');
      }

      let firstFrame = true;

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const captureTask = new CancellablePromise<void>(async (resolve, _, onCancel) => {
        let cancelled = false;
        onCancel(() => {
          cancelled = true;
        });

        for await (const frame of handle.playoutSource) {
          if (cancelled || frame === SynthesisHandle.FLUSH_SENTINEL) {
            break;
          }
          if (firstFrame) {
            this.#logger
              .child({ speechId: handle.speechId })
              .debug('started playing the first time');
            this.emit(AgentPlayoutEvent.PLAYOUT_STARTED);
            firstFrame = false;
          }
          handle.pushedDuration += (frame.samplesPerChannel / frame.sampleRate) * 1000;
          await this.#audioSource.captureFrame(frame);
          await this.#audioSource.waitForPlayout();
        }

        // XXX(nbsp): line 161 waits instead of this. this is not the case on python agents,
        //            but for some reason too many TTS frames can gunk up the buffer and lead to
        //            FFI errors. this works 🤷‍♀️
        // if (this.#audioSource.queuedDuration > 0) {
        //   await this.#audioSource.waitForPlayout();
        // }

        resolve();
      });

      try {
        await Promise.any([captureTask, handle.intFut.await]);
      } finally {
        cancel();
        resolve();
      }
    });
  }

  async close() {
    this.#closed = true;
    await this.#playoutTask;
  }
}
