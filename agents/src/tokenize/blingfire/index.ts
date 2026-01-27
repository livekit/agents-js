// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { BufferedSentenceStream } from '../token_stream.js';
import * as tokenizer from '../tokenizer.js';
import { TextToSentences } from './blingfire_wrapper.js';

interface TokenizerOptions {
  minSentenceLength: number;
  streamContextLength: number;
}

const defaultTokenizerOptions: TokenizerOptions = {
  minSentenceLength: 20,
  streamContextLength: 10,
};

/**
 * Split text into sentences using BlingFire's TextToSentences.
 * BlingFire returns sentences separated by newlines.
 */
const splitSentences = (text: string, minLength = 20): [string, number, number][] => {
  const result = TextToSentences(text);
  if (!result) {
    return [];
  }

  // BlingFire separates sentences with newlines
  const rawSentences = result.split('\n').filter((s) => s.trim().length > 0);

  const sentences: [string, number, number][] = [];
  let buf = '';
  let start = 0;
  let end = 0;
  let currentPos = 0;

  for (const sentence of rawSentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    // Find the sentence position in the original text
    const sentenceStart = text.indexOf(trimmed, currentPos);
    const sentenceEnd = sentenceStart + trimmed.length;

    buf += (buf ? ' ' : '') + trimmed;
    end = sentenceEnd;

    if (buf.length >= minLength) {
      sentences.push([buf, start, end]);
      start = sentenceEnd;
      buf = '';
    }

    currentPos = sentenceEnd;
  }

  // Push any remaining buffered text
  if (buf) {
    sentences.push([buf, start, text.length]);
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tokenize(text: string, language?: string): string[] {
    return splitSentences(text, this.#config.minSentenceLength).map((tok) => tok[0]);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  stream(language?: string): tokenizer.SentenceStream {
    return new BufferedSentenceStream(
      (text: string) => splitSentences(text, this.#config.minSentenceLength),
      this.#config.minSentenceLength,
      this.#config.streamContextLength,
    );
  }
}
