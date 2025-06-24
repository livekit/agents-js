// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { BufferedSentenceStream, BufferedWordStream } from '../token_stream.js';
import * as tokenizer from '../tokenizer.js';
import { hyphenator } from './hyphenator.js';
import { splitParagraphs } from './paragraph.js';
import { splitSentences } from './sentence.js';
import { splitWords } from './word.js';

interface TokenizerOptions {
  language: string;
  minSentenceLength: number;
  streamContextLength: number;
  retainFormat: boolean;
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
    return splitSentences(text, this.#config.minSentenceLength).map((tok) => tok[0]);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  stream(language?: string): tokenizer.SentenceStream {
    return new BufferedSentenceStream(
      (text: string) =>
        splitSentences(text, this.#config.minSentenceLength, this.#config.retainFormat),
      this.#config.minSentenceLength,
      this.#config.streamContextLength,
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
