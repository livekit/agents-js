// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { TransformStream } from 'node:stream/web';
import { log } from '../log.js';
import { SynthesizeStream, type TTS } from '../tts/index.js';
import { CancellablePromise, Future, gracefullyCancel } from '../utils.js';
import type { AgentPlayout, PlayoutHandle } from './agent_playout.js';

export type SpeechSource = AsyncIterable<string> | string | Promise<string>;

export class SynthesisHandle {
  static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');

  #speechId: string;
  ttsSource: SpeechSource;
  #agentPlayout: AgentPlayout;
  tts: TTS;
  queue = new TransformStream<
    AudioFrame | typeof SynthesisHandle.FLUSH_SENTINEL,
    AudioFrame | typeof SynthesisHandle.FLUSH_SENTINEL
  >();
  #playHandle?: PlayoutHandle;
  intFut = new Future();
  #logger = log();

  constructor(speechId: string, ttsSource: SpeechSource, agentPlayout: AgentPlayout, tts: TTS) {
    this.#speechId = speechId;
    this.ttsSource = ttsSource;
    this.#agentPlayout = agentPlayout;
    this.tts = tts;
  }

  get speechId(): string {
    return this.#speechId;
  }

  get validated(): boolean {
    return !!this.#playHandle;
  }

  get interrupted(): boolean {
    return this.intFut.done;
  }

  get playHandle(): PlayoutHandle | undefined {
    return this.#playHandle;
  }

  /** Validate the speech for playout. */
  play(): PlayoutHandle {
    if (this.interrupted) {
      throw new Error('synthesis was interrupted');
    }

    this.#playHandle = this.#agentPlayout.play(this.#speechId, this.queue.readable);
    return this.#playHandle;
  }

  /** Interrupt the speech. */
  interrupt() {
    if (this.interrupted) {
      return;
    }

    this.#logger.child({ speechId: this.#speechId }).debug('interrupting synthesis/playout');
    this.#playHandle?.interrupt();
    this.intFut.resolve();
  }
}

export class AgentOutput {
  #agentPlayout: AgentPlayout;
  #tts: TTS;
  #tasks: CancellablePromise<void>[] = [];

  constructor(agentPlayout: AgentPlayout, tts: TTS) {
    this.#agentPlayout = agentPlayout;
    this.#tts = tts;
  }

  get playout(): AgentPlayout {
    return this.#agentPlayout;
  }

  async close() {
    this.#tasks.forEach((task) => task.cancel());
    await Promise.all(this.#tasks);
  }

  synthesize(speechId: string, ttsSource: SpeechSource): SynthesisHandle {
    const handle = new SynthesisHandle(speechId, ttsSource, this.#agentPlayout, this.#tts);
    const task = this.#synthesize(handle);
    this.#tasks.push(task);
    task.finally(() => this.#tasks.splice(this.#tasks.indexOf(task)));
    return handle;
  }

  #synthesize(handle: SynthesisHandle): CancellablePromise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return new CancellablePromise(async (resolve, _, onCancel) => {
      const ttsSource = await handle.ttsSource;
      let task: CancellablePromise<void>;
      if (typeof ttsSource === 'string') {
        task = stringSynthesisTask(ttsSource, handle);
      } else {
        task = streamSynthesisTask(ttsSource, handle);
      }

      onCancel(() => {
        gracefullyCancel(task);
      });

      try {
        await Promise.any([task, handle.intFut.await]);
      } finally {
        if (handle.intFut.done) {
          gracefullyCancel(task);
        }
      }

      resolve();
    });
  }
}

const stringSynthesisTask = (text: string, handle: SynthesisHandle): CancellablePromise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return new CancellablePromise<void>(async (resolve, _, onCancel) => {
    let cancelled = false;
    onCancel(() => {
      cancelled = true;
    });

    const writer = handle.queue.writable.getWriter();

    const ttsStream = handle.tts.stream();
    ttsStream.pushText(text);
    ttsStream.flush();
    ttsStream.endInput();
    for await (const audio of ttsStream) {
      if (cancelled || audio === SynthesizeStream.END_OF_STREAM) {
        break;
      }
      await writer.write(audio.frame);
    }
    await writer.write(SynthesisHandle.FLUSH_SENTINEL);
    writer.releaseLock();

    resolve();
  });
};

const streamSynthesisTask = (
  stream: AsyncIterable<string>,
  handle: SynthesisHandle,
): CancellablePromise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return new CancellablePromise<void>(async (resolve, _, onCancel) => {
    let cancelled = false;
    onCancel(() => {
      cancelled = true;
    });

    const writer = handle.queue.writable.getWriter();

    const ttsStream = handle.tts.stream();
    const readGeneratedAudio = async () => {
      for await (const audio of ttsStream) {
        if (cancelled) break;
        if (audio === SynthesizeStream.END_OF_STREAM) {
          break;
        }
        await writer.write(audio.frame);
      }
      await writer.write(SynthesisHandle.FLUSH_SENTINEL);
      writer.releaseLock();
    };
    readGeneratedAudio();

    for await (const text of stream) {
      if (cancelled) break;
      ttsStream.pushText(text);
    }
    ttsStream.flush();
    ttsStream.endInput();

    resolve();
  });
};
