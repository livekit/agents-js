import type { SentenceTokenizer } from 'agents/src/tokenize/index.js';

export interface TranscriptionSynchronizerOptions {
  speed: number;
  hyphenateWord: (word: string) => string[];
  splitWords: (words: string) => [string, number, number][];
  sentenceTokenizer: SentenceTokenizer;
}

export const defaultTextSyncOptions: TranscriptionSynchronizerOptions = {
  speed: 1,
  sentenceTokenizer: new basic.SentenceTokenizer(),
  hyphenateWord: basic.hyphenateWord,
  splitWords: basic.splitWords,
};

export class TranscriptionSynchronizer {
  private options: TranscriptionSynchronizerOptions;

  constructor(options: TranscriptionSynchronizerOptions = defaultOptions) {
    this.options = options;
  }
}
