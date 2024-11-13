// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SentenceStream, SentenceTokenizer } from '../tokenize/index.js';
import type { ChunkedStream } from './tts.js';
import { SynthesizeStream, TTS } from './tts.js';

export class StreamAdapter extends TTS {
  #tts: TTS;
  #sentenceTokenizer: SentenceTokenizer;

  constructor(tts: TTS, sentenceTokenizer: SentenceTokenizer) {
    super(tts.sampleRate, tts.numChannels, { streaming: true });
    this.#tts = tts;
    this.#sentenceTokenizer = sentenceTokenizer;
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

  constructor(tts: TTS, sentenceTokenizer: SentenceTokenizer) {
    super();
    this.#tts = tts;
    this.#sentenceStream = sentenceTokenizer.stream();

    this.#run();
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
    };

    const synthesize = async () => {
      for await (const ev of this.#sentenceStream) {
        for await (const audio of this.#tts.synthesize(ev.token)) {
          this.queue.put(audio);
        }
        this.queue.put(SynthesizeStream.END_OF_STREAM);
      }
    };

    Promise.all([forwardInput(), synthesize()]);
  }
}
