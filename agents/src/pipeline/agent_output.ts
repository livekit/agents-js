// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { log } from '../log.js';
import type { SynthesizeStream } from '../tts/index.js';
import { AsyncIterableQueue, CancellablePromise, Future, gracefullyCancel } from '../utils.js';
import type { AgentPlayout, PlayoutHandle } from './agent_playout.js';

export type SpeechSource = AsyncIterable<string> | string | Promise<string>;

export class SynthesisHandle {
  #speechId: string;
  ttsSource: SpeechSource;
  #agentPlayout: AgentPlayout;
  ttsStream: SynthesizeStream;
  queue = new AsyncIterableQueue<AudioFrame>();
  #playHandle?: PlayoutHandle;
  intFut = new Future();
  #logger = log();

  constructor(
    speechId: string,
    ttsSource: SpeechSource,
    agentPlayout: AgentPlayout,
    ttsStream: SynthesizeStream,
  ) {
    this.#speechId = speechId;
    this.ttsSource = ttsSource;
    this.#agentPlayout = agentPlayout;
    this.ttsStream = ttsStream;
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
  #ttsStream: SynthesizeStream;
  #tasks: CancellablePromise<void>[] = [];

  constructor(agentPlayout: AgentPlayout, ttsStream: SynthesizeStream) {
    this.#agentPlayout = agentPlayout;
    this.#ttsStream = ttsStream;
  }

  get playout(): AgentPlayout {
    return this.#agentPlayout;
  }

  async close() {
    this.#tasks.forEach((task) => task.cancel());
    await Promise.all(this.#tasks);
  }

  synthesize(speechId: string, ttsSource: SpeechSource) {
    const handle = new SynthesisHandle(speechId, ttsSource, this.#agentPlayout, this.#ttsStream);
    const task = this.#synthesize(handle);
    this.#tasks.push(task);
    task.finally(() => this.#tasks.splice(this.#tasks.indexOf(task)));
  }

  #synthesize(handle: SynthesisHandle): CancellablePromise<void> {
    return new CancellablePromise(async (resolve, reject, onCancel) => {
      let cancelled = false;

      const ttsSource = await handle.ttsSource;
      let task: CancellablePromise<void>;
      if (typeof ttsSource === 'string') {
        task = stringSynthesisTask(ttsSource, handle);
      } else {
        task = streamSynthesisTask(ttsSource, handle);
      }

      onCancel(() => {
        cancelled = true;
        gracefullyCancel(task);
      });

      try {
        await Promise.any([task, handle.intFut]);
      } finally {
        cancelled = true;
        gracefullyCancel(task);
      }

      if (cancelled) {
        reject();
      } else {
        resolve();
      }
    });
  }
}

const stringSynthesisTask = (text: string, handle: SynthesisHandle): CancellablePromise<void> => {
  return new CancellablePromise<void>(async (resolve, reject, onCancel) => {
    let cancelled = false;
    onCancel(() => {
      cancelled = true;
    });

    handle.ttsStream.pushText(text);
    handle.ttsStream.flush();
    for await (const audio of handle.ttsStream) {
      if (cancelled) break;
      handle.queue.put(audio.frame);
    }

    if (cancelled) {
      reject();
    } else {
      resolve();
    }
  });
};

const streamSynthesisTask = (
  stream: AsyncIterable<string>,
  handle: SynthesisHandle,
): CancellablePromise<void> => {
  return new CancellablePromise<void>(async (resolve, reject, onCancel) => {
    let cancelled = false;
    onCancel(() => {
      cancelled = true;
    });

    const readGeneratedAudio = async () => {
      for await (const audio of handle.ttsStream) {
        if (cancelled) break;
        handle.queue.put(audio.frame);
      }
    };
    readGeneratedAudio();

    for await (const text of stream) {
      if (cancelled) break;
      handle.ttsStream.pushText(text);
    }

    handle.ttsStream.endInput();

    if (cancelled) {
      reject();
    } else {
      resolve();
    }
  });
};
