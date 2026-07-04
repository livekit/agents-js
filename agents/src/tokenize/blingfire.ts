// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import blingfire from '@livekit/blingfire';
import { BufferedSentenceStream, BufferedWordStream } from './token_stream.js';
import * as tokenizer from './tokenizer.js';

interface TokenizerOptions {
  minSentenceLength: number;
  streamContextLength: number;
  retainFormat: boolean;
}

const defaultTokenizerOptions: TokenizerOptions = {
  minSentenceLength: 20,
  streamContextLength: 10,
  retainFormat: false,
};

const splitSentences = (
  text: string,
  minSentenceLength: number,
  retainFormat: boolean,
): [string, number, number][] => {
  const { spans } = blingfire.textToSentencesWithOffsets(text);

  // Sentences shorter than minSentenceLength are merged into the next one
  // (start is only advanced once a long-enough sentence is emitted).
  const merged: [string, number, number][] = [];
  let start = 0;

  for (const [, end] of spans) {
    const raw = text.slice(start, end);
    const sentence = raw.replace(/\s*\n+\s*/g, ' ').trim();
    if (!sentence || sentence.length < minSentenceLength) continue;

    merged.push([retainFormat ? raw : sentence, start, end]);
    start = end;
  }

  if (start < text.length) {
    const raw = text.slice(start);
    if (retainFormat) {
      merged.push([raw, start, text.length]);
    } else {
      const sentence = raw.trim();
      if (sentence) merged.push([sentence, start, text.length]);
    }
  }

  return merged;
};

export const splitWords = (text: string, ignorePunctuation = true): [string, number, number][] => {
  const { spans } = blingfire.textToWordsWithOffsets(text);

  const words: [string, number, number][] = [];
  for (const [start, end] of spans) {
    let word = text.slice(start, end);
    if (ignorePunctuation) {
      // BlingFire splits punctuation into its own tokens; dropping the
      // all-punctuation ones matches basic.splitWords' stripping.
      word = word.replace(new RegExp(`[${tokenizer.PUNCTUATIONS.join('')}]`, 'g'), '');
      if (!word) continue;
    }
    if (!word.trim()) continue;
    words.push([word, start, end]);
  }

  return words;
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
    return splitSentences(text, this.#config.minSentenceLength, this.#config.retainFormat).map(
      (tok) => tok[0],
    );
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
