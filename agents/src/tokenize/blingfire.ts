// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { BufferedSentenceStream, xmlWrapTokenizer } from './token_stream.js';
import * as tokenizer from './tokenizer.js';

type Blingfire = typeof import('@livekit/blingfire');

const cjsRequire = createRequire(import.meta.url);

let native: Blingfire | undefined;

// Loaded on first use, so importing @livekit/agents never fails on a platform without a
// prebuilt binary; only using this tokenizer there throws.
function blingfire(): Blingfire {
  native ??= cjsRequire('@livekit/blingfire') as Blingfire;
  return native;
}

// a danda, plus any closing quotes/brackets it ends, followed by whitespace
const DANDA_BOUNDARY_RE = /[।॥]["'”’»)]*(?=\s)/g;

const splitSentences = (
  text: string,
  minSentenceLength: number,
  retainFormat: boolean,
): [string, number, number][] => {
  if (!text || !text.trim()) return [];

  const { spans } = blingfire().textToSentencesWithOffsets(text);

  // blingfire doesn't treat the danda ("।", "॥") used by Hindi, Bengali, etc. as a
  // sentence terminator, so also end a sentence after a danda followed by whitespace
  const ends = [
    ...new Set([
      ...spans.map(([, end]) => end),
      ...Array.from(text.matchAll(DANDA_BOUNDARY_RE), (m) => m.index! + m[0].length),
    ]),
  ].sort((a, b) => a - b);

  const sentences: [string, number, number][] = [];
  let start = 0;

  for (const end of ends) {
    const rawSentence = text.slice(start, end);
    const sentence = rawSentence.replace(/\s*\n+\s*/g, ' ').trim();
    if (!sentence || sentence.length < minSentenceLength) continue;

    sentences.push([retainFormat ? rawSentence : sentence, start, end]);
    start = end;
  }

  if (start < text.length) {
    const rawSentence = text.slice(start);
    if (retainFormat) {
      sentences.push([rawSentence, start, text.length]);
    } else {
      const sentence = rawSentence.trim();
      if (sentence) sentences.push([sentence, start, text.length]);
    }
  }

  return sentences;
};

interface TokenizerOptions {
  /**
   * Minimum length for a span to be treated as its own sentence; shorter spans are merged
   * forward into the next one.
   */
  minSentenceLength: number;
  /** Minimum buffered text before the stream emits. */
  streamContextLength: number;
  /** Keep original whitespace/formatting in emitted tokens. */
  retainFormat: boolean;
  /**
   * Hard cap on emitted token length; a token is flushed before appending a sentence that
   * would exceed it. Unlimited when omitted.
   */
  maxTokenLength?: number;
  /**
   * Minimum length a token must reach before it is emitted. Sentences are batched together
   * until the running token reaches this length, so raising it (e.g. toward
   * `maxTokenLength`) yields larger, fewer chunks. Defaults to `minSentenceLength`
   * (per-sentence emission).
   */
  minTokenLength?: number;
  /**
   * Minimum length for the *first* token of each segment, when it should differ from
   * `minTokenLength`. Lets a batching consumer still emit its opening chunk as soon as one
   * sentence is ready, so batching costs nothing at the head of a segment.
   */
  firstTokenLength?: number;
  /**
   * Treat XML markup as atomic — never split a tag across tokens and keep tags attached to
   * the following sentence. Only enable when the input actually carries markup (e.g.
   * expressive TTS): a stray "<" in plain text can otherwise hold back streaming until
   * flush.
   */
  xmlAware?: boolean;
}

const defaultTokenizerOptions: TokenizerOptions = {
  minSentenceLength: 20,
  streamContextLength: 10,
  retainFormat: false,
};

export class SentenceTokenizer extends tokenizer.SentenceTokenizer {
  #config: TokenizerOptions;

  constructor(options?: Partial<TokenizerOptions>) {
    super();
    this.#config = {
      ...defaultTokenizerOptions,
      ...options,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tokenize(text: string, language?: string): string[] {
    const split = (input: string) =>
      splitSentences(input, this.#config.minSentenceLength, this.#config.retainFormat);
    const tokenizeFnc = this.#config.xmlAware ? xmlWrapTokenizer(split) : split;
    return tokenizeFnc(text).map((tok) => (Array.isArray(tok) ? tok[0] : tok));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  stream(language?: string): tokenizer.SentenceStream {
    return new BufferedSentenceStream(
      (text: string) =>
        splitSentences(text, this.#config.minSentenceLength, this.#config.retainFormat),
      this.#config.minTokenLength ?? this.#config.minSentenceLength,
      this.#config.streamContextLength,
      {
        maxTokenLength: this.#config.maxTokenLength,
        firstTokenLength: this.#config.firstTokenLength,
        xmlAware: this.#config.xmlAware,
      },
    );
  }
}
