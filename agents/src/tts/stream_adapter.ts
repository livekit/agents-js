// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SentenceStream, SentenceTokenizer } from '../tokenize.js';
import type { ChunkedStream } from './tts.js';
import { SynthesisEvent, SynthesisEventType, SynthesizeStream, TTS } from './tts.js';

export class StreamAdapterWrapper extends SynthesizeStream {
  #closed: boolean;
  #tts: TTS;
  #sentenceStream: SentenceStream;
  #eventQueue: (SynthesisEvent | undefined)[];
  #task: {
    run: Promise<void>;
    cancel: () => void;
  };

  constructor(tts: TTS, sentenceStream: SentenceStream) {
    super();
    this.#closed = false;
    this.#tts = tts;
    this.#sentenceStream = sentenceStream;
    this.#eventQueue = [];
    this.#task = {
      run: new Promise((_, reject) => {
        this.run(reject);
      }),
      cancel: () => {},
    };
  }

  async run(reject: (arg: Error) => void) {
    while (!this.#closed) {
      this.#task.cancel = () => {
        this.#closed = true;
        reject(new Error('cancelled'));
      };
      for await (const sentence of this.#sentenceStream) {
        const audio = await this.#tts.synthesize(sentence.text).then((data) => data.next());
        if (!audio.done) {
          this.#eventQueue.push(new SynthesisEvent(SynthesisEventType.STARTED));
          this.#eventQueue.push(new SynthesisEvent(SynthesisEventType.AUDIO, audio.value));
          this.#eventQueue.push(new SynthesisEvent(SynthesisEventType.FINISHED));
        }
      }
    }
  }

  pushText(token: string) {
    this.#sentenceStream.pushText(token);
  }

  async flush() {
    await this.#sentenceStream.flush();
  }

  next(): IteratorResult<SynthesisEvent> {
    const event = this.#eventQueue.shift();
    if (event) {
      return { done: false, value: event };
    } else {
      return { done: true, value: undefined };
    }
  }

  async close(): Promise<void> {
    this.#task.cancel();
    try {
      await this.#task.run;
    } finally {
      this.#eventQueue.push(undefined);
    }
  }
}

export class StreamAdapter extends TTS {
  #tts: TTS;
  #tokenizer: SentenceTokenizer;

  constructor(tts: TTS, tokenizer: SentenceTokenizer) {
    super(true);
    this.#tts = tts;
    this.#tokenizer = tokenizer;
  }

  synthesize(text: string): Promise<ChunkedStream> {
    return this.#tts.synthesize(text);
  }

  stream() {
    return new StreamAdapterWrapper(this.#tts, this.#tokenizer.stream(undefined));
  }
}
