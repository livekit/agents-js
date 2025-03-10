// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SentenceStream, SentenceTokenizer } from '../tokenize/index.js';
import type { ChunkedStream } from './tts.js';
import { SynthesizeStream, TTS, TTSEvent } from './tts.js';

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

    this.#tts.on(TTSEvent.METRICS_COLLECTED, (metrics) => {
      this.emit(TTSEvent.METRICS_COLLECTED, metrics);
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

    this.#run();
  }

  async monitorMetrics() {
    return; // do nothing
  }

  async #run() {
    const forwardInput = async () => {
      for await (const input of this.input) {
        if (input === SynthesizeStream.FLUSH_SENTINEL) {
          this.#sentenceStream.flush();
        } else {
          this.#sentenceStream.pushText(input);
        }
      }
      this.#sentenceStream.endInput();
      this.#sentenceStream.close();
    };

    const synthesize = async () => {
      for await (const ev of this.#sentenceStream) {
        for await (const audio of this.#tts.synthesize(ev.token)) {
          this.output.put(audio);
        }
      }
      this.output.put(SynthesizeStream.END_OF_STREAM);
    };

    Promise.all([forwardInput(), synthesize()]);
  }
}
