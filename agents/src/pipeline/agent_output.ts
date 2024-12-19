// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { log } from '../log.js';
import { SynthesizeStream, type TTS } from '../tts/index.js';
import { AsyncIterableQueue, CancellablePromise, Future, gracefullyCancel } from '../utils.js';
import type { AgentPlayout, PlayoutHandle } from './agent_playout.js';

export type SpeechSource = AsyncIterable<string> | string | Promise<string>;

export class SynthesisHandle {
  static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');

  #speechId: string;
  text?: string;
  ttsSource: SpeechSource;
  #agentPlayout: AgentPlayout;
  tts: TTS;
  queue = new AsyncIterableQueue<AudioFrame | typeof SynthesisHandle.FLUSH_SENTINEL>();
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

    this.#playHandle = this.#agentPlayout.play(this.#speechId, this.queue);
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
      let task: CancellablePromise<string>;
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
        } else {
          task.then((text) => {
            handle.text = text;
          });
        }
      }

      resolve();
    });
  }
}

const stringSynthesisTask = (text: string, handle: SynthesisHandle): CancellablePromise<string> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return new CancellablePromise(async (resolve, _, onCancel) => {
    let cancelled = false;
    onCancel(() => {
      cancelled = true;
    });

    const ttsStream = handle.tts.stream();
    ttsStream.pushText(text);
    ttsStream.flush();
    ttsStream.endInput();
    for await (const audio of ttsStream) {
      if (cancelled || audio === SynthesizeStream.END_OF_STREAM) {
        break;
      }
      handle.queue.put(audio.frame);
    }
    handle.queue.put(SynthesisHandle.FLUSH_SENTINEL);

    resolve(text);
  });
};

const streamSynthesisTask = (
  stream: AsyncIterable<string>,
  handle: SynthesisHandle,
): CancellablePromise<string> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return new CancellablePromise(async (resolve, _, onCancel) => {
    let fullText = '';
    let cancelled = false;
    onCancel(() => {
      cancelled = true;
    });

    const ttsStream = handle.tts.stream();
    const readGeneratedAudio = async () => {
      for await (const audio of ttsStream) {
        if (cancelled) break;
        if (audio === SynthesizeStream.END_OF_STREAM) {
          break;
        }
        handle.queue.put(audio.frame);
      }
      handle.queue.put(SynthesisHandle.FLUSH_SENTINEL);
    };
    readGeneratedAudio();

    for await (const text of stream) {
      fullText += text;
      if (cancelled) break;
      ttsStream.pushText(text);
    }
    ttsStream.flush();
    ttsStream.endInput();

    resolve(fullText);
  });
};
