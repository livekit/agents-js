// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { TTSMetrics } from '../metrics/base.js';
import { type SentenceStream, type SentenceTokenizer, basic } from '../tokenize/index.js';
import type { APIConnectOptions } from '../types.js';
import { USERDATA_TIMED_TRANSCRIPT } from '../types.js';
import { Task } from '../utils.js';
import { createTimedString } from '../voice/io.js';
import type { ChunkedStream, TTSError } from './tts.js';
import { SynthesizeStream, TTS } from './tts.js';

export class StreamAdapter extends TTS {
  #tts: TTS;
  #sentenceTokenizer: SentenceTokenizer;
  #explicitTokenizer: boolean;
  #markupTokenizer?: SentenceTokenizer;
  label: string;

  #forwardMetrics = (metrics: TTSMetrics) => {
    this.emit('metrics_collected', metrics);
  };

  #forwardError = (error: TTSError) => {
    this.emit('error', error);
  };

  constructor(tts: TTS, sentenceTokenizer?: SentenceTokenizer) {
    super(tts.sampleRate, tts.numChannels, { streaming: true, alignedTranscript: true });
    this.#tts = tts;
    this.#explicitTokenizer = sentenceTokenizer !== undefined;
    this.#sentenceTokenizer = sentenceTokenizer ?? new basic.SentenceTokenizer();
    this.label = this.#tts.label;
    this.label = `tts.StreamAdapter<${this.#tts.label}>`;

    this.#tts.on('metrics_collected', this.#forwardMetrics);
    this.#tts.on('error', this.#forwardError);
  }

  // a pass-through speaks whatever dialect it wraps
  protected override markupProviderKey(): string {
    return this.#tts.markup.providerKey;
  }

  /**
   * StreamAdapterWrapper reads the wrapped instance's flag, so an adapter handed straight
   * to the session has to pass this through.
   *
   * @internal
   */
  override _setExpressive(enabled: boolean): void {
    super._setExpressive(enabled);
    this.#tts._setExpressive(enabled);
  }

  /**
   * The sentence tokenizer for one synthesis.
   *
   * A marker must never be split across two tokens — the sentence-level lowering in
   * `StreamAdapterWrapper` would see half a tag and send the halves on as words. A
   * label is free-form English and may well contain a period, so an unguarded tokenizer
   * really does split them. The framework passes an xml-aware tokenizer when it builds the
   * adapter itself; a caller relying on the default gets one here, and only while markup is
   * actually flowing, so a plain turn never pays the stray-`<` stall.
   *
   * @internal
   */
  _tokenizerFor(options: { lowering: boolean }): SentenceTokenizer {
    if (!options.lowering || this.#explicitTokenizer) {
      return this.#sentenceTokenizer;
    }
    this.#markupTokenizer ??= new basic.SentenceTokenizer({ xmlAware: true });
    return this.#markupTokenizer;
  }

  async close(): Promise<void> {
    this.#tts.off('metrics_collected', this.#forwardMetrics);
    this.#tts.off('error', this.#forwardError);
    await super.close();
  }

  override async releaseIdleConnections(): Promise<void> {
    await this.#tts.releaseIdleConnections();
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return this.#tts.synthesize(text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): StreamAdapterWrapper {
    // decided now, alongside the wrapper's own snapshot of the expressive flag
    const lowering = !!this.#tts.markup.providerKey && this.#tts.expressive;
    return new StreamAdapterWrapper(
      this.#tts,
      this._tokenizerFor({ lowering }),
      options?.connOptions,
    );
  }
}

export class StreamAdapterWrapper extends SynthesizeStream {
  #tts: TTS;
  #sentenceStream: SentenceStream;
  #expressive: boolean;
  #sentenceError?: Error;
  label: string;

  constructor(tts: TTS, sentenceTokenizer: SentenceTokenizer, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#tts = tts;
    // Snapshot whether expressive is active now, while the framework holds it fixed for this
    // synthesis (set synchronously before stream()). run() happens later, and the flag lives
    // on the shared TTS, so another turn or session could flip it in between.
    this.#expressive = tts.expressive;
    this.#sentenceStream = sentenceTokenizer.stream();
    this.label = `tts.StreamAdapterWrapper<${this.#tts.label}>`;
  }

  /**
   * Whether expressive was active when this stream was created.
   * @internal
   */
  get expressive(): boolean {
    return this.#expressive;
  }

  /**
   * Falls back to the first error a sentence failed with. A failed sentence is
   * skipped rather than failing this stream, so without this a consumer would
   * never learn that part of the speech is missing, or why.
   * @internal
   */
  override get error(): Error | undefined {
    return super.error ?? this.#sentenceError;
  }

  protected async run() {
    let cumulativeDuration = 0;
    // the framework's input path for every non-streaming TTS, and the first place whole
    // sentences exist
    const markup = this.#tts.markup;
    const lowering = !!markup.providerKey && this.#expressive;

    const forwardInput = async () => {
      for await (const input of this.input) {
        if (this.abortController.signal.aborted) break;

        if (input === SynthesizeStream.FLUSH_SENTINEL) {
          this.#sentenceStream.flush();
        } else {
          this.#sentenceStream.pushText(lowering ? markup.normalize(input) : input);
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

        let text = ev.token;
        if (lowering) {
          // re-normalize: a marker split across two input chunks isn't caught by the
          // per-chunk pass above
          text = markup.convert(markup.normalize(text)).trim();
          if (!text) continue;
        }

        // this will enable non-blocking synthesis of the stream of tokens
        task = Task.from(
          (controller) => synthesize(text, ev.token, task, controller),
          this.abortController,
        );

        tokenCompletionTasks.push(task);
      }

      await ThrowsPromise.all(tokenCompletionTasks.map((t) => t.result));
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    };

    const synthesize = async (
      text: string,
      token: string,
      prevTask: Task<void> | undefined,
      controller: AbortController,
    ) => {
      this.markStarted();
      const audioStream = this.#tts.synthesize(text, this.connOptions, this.abortSignal);

      // wait for previous audio transcription to complete before starting
      // to queuing audio frames of the current token
      await prevTask?.result;
      if (controller.signal.aborted) return;

      // Create a TimedString with the sentence text and current cumulative duration. The
      // transcript keeps the text as written: the sinks strip markup themselves, and the
      // lowered form carries provider-native spellings (e.g. an emphasized word in caps)
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
      this.#sentenceError ??= audioStream.error;
    };

    await ThrowsPromise.all([forwardInput(), synthesizeSentenceStream()]);
  }
}
