// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SentenceStream, SentenceTokenizer } from '../tokenize/index.js';
import type { APIConnectOptions } from '../types.js';
import { USERDATA_TIMED_TRANSCRIPT } from '../types.js';
import { Task } from '../utils.js';
import { createTimedString } from '../voice/io.js';
import type { ChunkedStream } from './tts.js';
import { SynthesizeStream, TTS } from './tts.js';

export class StreamAdapter extends TTS {
  #tts: TTS;
  #sentenceTokenizer: SentenceTokenizer;
  label: string;

  constructor(tts: TTS, sentenceTokenizer: SentenceTokenizer) {
    super(tts.sampleRate, tts.numChannels, { streaming: true, alignedTranscript: true });
    this.#tts = tts;
    this.#sentenceTokenizer = sentenceTokenizer;
    this.label = this.#tts.label;
    this.label = `tts.StreamAdapter<${this.#tts.label}>`;

    this.#tts.on('metrics_collected', (metrics) => {
      this.emit('metrics_collected', metrics);
    });
    this.#tts.on('error', (error) => {
      this.emit('error', error);
    });
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return this.#tts.synthesize(text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): StreamAdapterWrapper {
    return new StreamAdapterWrapper(this.#tts, this.#sentenceTokenizer, options?.connOptions);
  }
}

export class StreamAdapterWrapper extends SynthesizeStream {
  #tts: TTS;
  #sentenceStream: SentenceStream;
  label: string;

  constructor(tts: TTS, sentenceTokenizer: SentenceTokenizer, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#tts = tts;
    this.#sentenceStream = sentenceTokenizer.stream();
    this.label = `tts.StreamAdapterWrapper<${this.#tts.label}>`;
  }

  protected async run() {
    let cumulativeDuration = 0;

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
      const audioStream = this.#tts.synthesize(token, this.connOptions, this.abortSignal);

      // wait for previous audio transcription to complete before starting
      // to queuing audio frames of the current token
      await prevTask?.result;
      if (controller.signal.aborted) return;

      // Create a TimedString with the sentence text and current cumulative duration
      const timedString = createTimedString({
        text: token,
        startTime: cumulativeDuration,
      });

      let isFirstFrame = true;
      for await (const audio of audioStream) {
        if (controller.signal.aborted) break;

        // Attach the TimedString to the first frame of this sentence
        if (isFirstFrame) {
          audio.frame.userdata[USERDATA_TIMED_TRANSCRIPT] = [timedString];
          isFirstFrame = false;
        }

        // Track cumulative duration
        const frameDuration = audio.frame.samplesPerChannel / audio.frame.sampleRate;
        cumulativeDuration += frameDuration;

        this.queue.put(audio);
      }
    };

    await Promise.all([forwardInput(), synthesizeSentenceStream()]);
  }
}
