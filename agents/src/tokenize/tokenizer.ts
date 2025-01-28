// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// prettier-ignore
export const PUNCTUATIONS = [
  '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=',
  '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~', '±', '—', '‘', '’', '“', '”',
  '…',
]

export interface TokenData {
  segmentId: string;
  token: string;
}

export abstract class SentenceTokenizer {
  abstract tokenize(text: string, language?: string): string[];

  /**
   * Returns a {@link SentenceStream} that can be used to push strings and receive smaller segments.
   */
  abstract stream(): SentenceStream;
}

export abstract class SentenceStream {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new TransformStream<
    string | typeof SentenceStream.FLUSH_SENTINEL,
    string | typeof SentenceStream.FLUSH_SENTINEL
  >();
  protected output = new TransformStream<TokenData, TokenData>();
  #closed = false;
  #inputClosed = false;
  #reader = this.output.readable.getReader();
  #writer = this.input.writable.getWriter();

  get closed(): boolean {
    return this.#closed;
  }

  /** Push a string of text to the tokenizer */
  pushText(text: string) {
    if (this.#inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.#writer.write(text);
  }

  /** Flush the tokenizer, causing it to process all pending text */
  flush() {
    if (this.#inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.input.writable.getWriter().write(SentenceStream.FLUSH_SENTINEL);
  }

  /** Mark the input as ended and forbid additional pushes */
  endInput() {
    if (this.#inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.#writer.close();
    this.#inputClosed = true;
  }

  async next(): Promise<IteratorResult<TokenData>> {
    return this.#reader.read().then(({ value }) => {
      if (value) {
        return { value, done: false };
      } else {
        return { value: undefined, done: true };
      }
    });
  }

  /** Close both the input and output of the tokenizer stream */
  close() {
    if (!this.#inputClosed) {
      this.endInput();
    }
    this.#closed = true;
  }

  [Symbol.asyncIterator](): SentenceStream {
    return this;
  }
}

export abstract class WordTokenizer {
  abstract tokenize(text: string, language?: string): string[];

  /**
   * Returns a {@link WordStream} that can be used to push words and receive smaller segments.
   */
  abstract stream(): WordStream;
}

export abstract class WordStream {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new TransformStream<
    string | typeof WordStream.FLUSH_SENTINEL,
    string | typeof WordStream.FLUSH_SENTINEL
  >();
  protected output = new TransformStream<TokenData, TokenData>();
  #writer = this.input.writable.getWriter();
  #reader = this.output.readable.getReader();
  #inputClosed = false;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Push a string of text to the tokenizer */
  pushText(text: string) {
    if (this.#inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.#writer.write(text);
  }

  /** Flush the tokenizer, causing it to process all pending text */
  flush() {
    if (this.#inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.#writer.write(WordStream.FLUSH_SENTINEL);
  }

  /** Mark the input as ended and forbid additional pushes */
  endInput() {
    if (this.#inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.#inputClosed = true;
  }

  async next(): Promise<IteratorResult<TokenData>> {
    return this.#reader.read().then(({ value }) => {
      if (value) {
        return { value, done: false };
      } else {
        return { value: undefined, done: true };
      }
    });
  }

  /** Close both the input and output of the tokenizer stream */
  close() {
    this.endInput();
    this.#writer.close();
    this.#closed = true;
  }

  [Symbol.asyncIterator](): WordStream {
    return this;
  }
}
