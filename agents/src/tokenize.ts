// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface SegmentedSentence {
  text: string;
}

export abstract class SentenceTokenizer {
  abstract tokenize(text: string, language?: string): SegmentedSentence[];
  abstract stream(language: string | undefined): SentenceStream;
}

export abstract class SentenceStream implements IterableIterator<SegmentedSentence> {
  abstract pushText(text: string): void;
  abstract flush(): Promise<void>;
  async close(): Promise<void> {}
  abstract next(): IteratorResult<SegmentedSentence>;
  [Symbol.iterator](): SentenceStream {
    return this;
  }
}
