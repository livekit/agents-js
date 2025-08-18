// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SentenceStream, SentenceTokenizer } from '../tokenize/index.js';
import { Task } from '../utils.js';
import type { ChunkedStream } from './tts.js';
import { SynthesizeStream, TTS } from './tts.js';

export class StreamAdapter extends TTS {
  #tts: TTS;
  #sentenceTokenizer: SentenceTokenizer;
  label: string;

  constructor(tts: TTS, sentenceTokenizer: SentenceTokenizer) {
    super(tts.sampleRate, tts.numChannels, { streaming: true });
    this.#tts = tts;
    this.#sentenceTokenizer = sentenceTokenizer;
    this.label = this.#tts.label;
    this.label = `tts.StreamAdapter<${this.#tts.label}>`;

    this.#tts.on('metrics_collected', (metrics) => {
      this.emit('metrics_collected', metrics);
    });
  }

  synthesize(text: string): ChunkedStream {
    return this.#tts.synthesize(text);
  }

  stream(): StreamAdapterWrapper {
    return new StreamAdapterWrapper(this.#tts, this.#sentenceTokenizer);
  }
}

export class StreamAdapterWrapper extends SynthesizeStream {
  #tts: TTS;
  #sentenceStream: SentenceStream;
  label: string;

  constructor(tts: TTS, sentenceTokenizer: SentenceTokenizer) {
    super(tts);
    this.#tts = tts;
    this.#sentenceStream = sentenceTokenizer.stream();
    this.label = `tts.StreamAdapterWrapper<${this.#tts.label}>`;
  }

  protected async run() {
    const forwardInput = async () => {
      for await (const input of this.input) {
        if (this.abortController.signal.aborted) break;

        if (input === SynthesizeStream.FLUSH_SENTINEL) {
          this.#sentenceStream.flush();
        } else {
          this.#sentenceStream.pushText(input);
        }
      }
      this.#sentenceStream.endInput();
      this.#sentenceStream.close();
    };

    const synthesizeSentenceStream = async () => {
      let task: Task<void> | undefined;
      const tokenCompletionTasks: Task<void>[] = [];

      for await (const ev of this.#sentenceStream) {
        if (this.abortController.signal.aborted) break;

        // this will enable non-blocking synthesis of the stream of tokens
        task = Task.from(
          (controller) => synthesize(ev.token, task, controller),
          this.abortController,
        );

        tokenCompletionTasks.push(task);
      }

      await Promise.all(tokenCompletionTasks.map((t) => t.result));
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    };

    const synthesize = async (
      token: string,
      prevTask: Task<void> | undefined,
      controller: AbortController,
    ) => {
      const audioStream = this.#tts.synthesize(token);

      // wait for previous audio transcription to complete before starting
      // to queuing audio frames of the current token
      await prevTask?.result;
      if (controller.signal.aborted) return;

      for await (const audio of audioStream) {
        if (controller.signal.aborted) break;
        this.queue.put(audio);
      }
    };

    await Promise.all([forwardInput(), synthesizeSentenceStream()]);
  }
}
