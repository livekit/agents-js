// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { BufferedSentenceStream, BufferedWordStream, xmlWrapTokenizer } from '../token_stream.js';
import * as tokenizer from '../tokenizer.js';
import { hyphenator } from './hyphenator.js';
import { splitParagraphs } from './paragraph.js';
import { splitSentences } from './sentence.js';
import { splitWords } from './word.js';

interface TokenizerOptions {
  language: string;
  /**
   * Minimum length for a span to be treated as its own sentence; shorter spans
   * are merged forward into the next one.
   */
  minSentenceLength: number;
  /** Minimum buffered text before the stream emits. */
  streamContextLength: number;
  /** Keep original whitespace/formatting in emitted tokens. */
  retainFormat: boolean;
  /**
   * Hard cap on emitted token length; a token is flushed before appending a
   * sentence that would exceed it.
   */
  maxTokenLength?: number;
  /**
   * Minimum length a token must reach before it is emitted. Sentences are
   * batched together until the running token reaches this length, so raising
   * it (e.g. toward `maxTokenLength`) yields larger, fewer chunks. Defaults to
   * `minSentenceLength` (per-sentence emission).
   */
  minTokenLength?: number;
  /**
   * Treat XML markup as atomic — never split a tag across tokens and keep tags
   * attached to the following sentence. Only enable when the input actually
   * carries markup (e.g. expressive TTS): a stray "<" in plain text can
   * otherwise hold back streaming until flush.
   */
  xmlAware?: boolean;
}

const defaultTokenizerOptions: TokenizerOptions = {
  language: 'en-US',
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
    let tokenizeFunc = (t: string) =>
      splitSentences(t, this.#config.minSentenceLength, this.#config.retainFormat);
    if (this.#config.xmlAware) {
      tokenizeFunc = xmlWrapTokenizer(tokenizeFunc) as typeof tokenizeFunc;
    }
    return tokenizeFunc(text).map((tok) => (Array.isArray(tok) ? tok[0] : tok));
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
        xmlAware: this.#config.xmlAware,
      },
    );
  }
}

export class WordTokenizer extends tokenizer.WordTokenizer {
  #ignorePunctuation: boolean;

  constructor(ignorePunctuation = true) {
    super();
    this.#ignorePunctuation = ignorePunctuation;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tokenize(text: string, language?: string): string[] {
    return splitWords(text, this.#ignorePunctuation).map((tok) => tok[0]);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  stream(language?: string): tokenizer.WordStream {
    return new BufferedWordStream(
      (text: string) => splitWords(text, this.#ignorePunctuation),
      1,
      1,
    );
  }
}

export const hyphenateWord = (word: string): string[] => {
  return hyphenator.hyphenateWord(word);
};

export { splitWords };

export const tokenizeParagraphs = (text: string): string[] => {
  return splitParagraphs(text).map((tok) => tok[0]);
};
