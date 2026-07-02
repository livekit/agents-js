// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { textToSentences } from 'blingfire';
import { BufferedSentenceStream } from './token_stream.js';
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
  retainFormat = false,
): [string, number, number][] => {
  const sentenceTexts = textToSentences(text)
    .split('\n')
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  const sentences: [string, number, number][] = [];
  const ends: number[] = [];
  let searchStart = 0;

  for (const sentence of sentenceTexts) {
    const start = text.indexOf(sentence, searchStart);
    if (start === -1) continue;

    const end = start + sentence.length;
    ends.push(end);
    searchStart = end;
  }

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

export class SentenceTokenizer extends tokenizer.SentenceTokenizer {
  #config: TokenizerOptions;

  constructor(options?: Partial<TokenizerOptions>) {
    super();
    this.#config = {
      ...defaultTokenizerOptions,
      ...options,
    };
  }

  tokenize(text: string, _language?: string): string[] {
    return splitSentences(text, this.#config.minSentenceLength, this.#config.retainFormat).map(
      (tok) => tok[0],
    );
  }

  stream(_language?: string): tokenizer.SentenceStream {
    return new BufferedSentenceStream(
      (text: string) =>
        splitSentences(text, this.#config.minSentenceLength, this.#config.retainFormat),
      this.#config.minSentenceLength,
      this.#config.streamContextLength,
    );
  }
}
