import * as tokenizer from '../index.js';
import { BufferedSentenceStream } from '../token_stream.js';
import { hyphenator } from './hyphenator.js';
import { splitParagraphs } from './paragraph.js';
import { splitSentences } from './sentence.js';
import { splitWords } from './word';

interface TokenizerOptions {
  language: string;
  minSentenceLength: number;
  streamContextLength: number;
}

export class SentenceTokenizer extends tokenizer.SentenceTokenizer {
  #config: TokenizerOptions;

  constructor(language = 'en-US', minSentenceLength = 20, streamContextLength = 10) {
    super();
    this.#config = {
      language,
      minSentenceLength,
      streamContextLength,
    };
  }

  tokenize(text: string, language?: string): string[] {
    return splitSentences(text, this.#config.minSentenceLength).map((tok) => tok[0]);
  }

  stream(language?: string): tokenizer.SentenceStream {
    return new BufferedSentenceStream(
      (text: string) => splitSentences(text, this.#config.minSentenceLength),
      this.#config.minSentenceLength,
      this.#config.streamContextLength,
    );
  }
}

export class WordTokenizer extends tokenizer.SentenceTokenizer {
  #ignorePunctuation: boolean;

  constructor(ignorePunctuation = true) {
    super();
    this.#ignorePunctuation = ignorePunctuation;
  }

  tokenize(text: string, language?: string): string[] {
    return splitWords(text, this.#ignorePunctuation).map((tok) => tok[0]);
  }

  stream(language?: string): tokenizer.SentenceStream {
    return new BufferedSentenceStream(
      (text: string) => splitWords(text, this.#ignorePunctuation),
      1,
      1,
    );
  }
}

export const hyphenateWord = (word: string): string[] => {
  return hyphenator.hyphenateWord(word);
};

export const tokenizeParagraphs = (text: string): string[] => {
  return splitParagraphs(text).map((tok) => tok[0]);
};
