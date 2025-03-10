// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { AsyncIterableQueue } from '../utils.js';
import type { TokenData } from './tokenizer.js';
import { SentenceStream, WordStream } from './tokenizer.js';

type TokenizeFunc = (x: string) => string[] | [string, number, number][];

export class BufferedTokenStream implements AsyncIterableIterator<TokenData> {
  protected queue = new AsyncIterableQueue<TokenData>();
  protected closed = false;

  #func: TokenizeFunc;
  #minTokenLength: number;
  #minContextLength: number;
  #bufTokens: string[] = [];
  #inBuf = '';
  #outBuf = '';
  #currentSegmentId: string;

  constructor(func: TokenizeFunc, minTokenLength: number, minContextLength: number) {
    this.#func = func;
    this.#minTokenLength = minTokenLength;
    this.#minContextLength = minContextLength;

    this.#currentSegmentId = randomUUID();
  }

  /** Push a string of text into the token stream */
  pushText(text: string) {
    if (this.closed) {
      throw new Error('Stream is closed');
    }

    this.#inBuf += text;
    if (this.#inBuf.length < this.#minContextLength) return;

    while (true) {
      const tokens = this.#func(this.#inBuf);
      if (tokens.length <= 1) break;

      if (this.#outBuf) this.#outBuf += ' ';

      const tok = tokens.shift()!;
      let tokText: string;
      if (Array.isArray(tok)) {
        tokText = tok[0];
      } else {
        tokText = tok;
      }

      this.#outBuf += tokText;

      if (this.#outBuf.length >= this.#minTokenLength) {
        this.queue.put({ token: this.#outBuf, segmentId: this.#currentSegmentId });
        this.#outBuf = '';
      }

      if (typeof tok! !== 'string') {
        this.#inBuf = this.#inBuf.slice(tok![2]);
      } else {
        this.#inBuf = this.#inBuf
          .slice(Math.max(0, this.#inBuf.indexOf(tok)) + tok.length)
          .trimStart();
      }
    }
  }

  /** Flush the stream, causing it to process all pending text */
  flush() {
    if (this.closed) {
      throw new Error('Stream is closed');
    }

    if (this.#inBuf || this.#outBuf) {
      const tokens = this.#func(this.#inBuf);
      if (tokens) {
        if (this.#outBuf) this.#outBuf += ' ';

        if (Array.isArray(tokens[0])) {
          this.#outBuf += tokens.map((tok) => tok[0]).join(' ');
        } else {
          this.#outBuf += tokens.join(' ');
        }
      }

      if (this.#outBuf) {
        this.queue.put({ token: this.#outBuf, segmentId: this.#currentSegmentId });
      }

      this.#currentSegmentId = randomUUID();
    }

    this.#inBuf = '';
    this.#outBuf = '';
  }

  /** Mark the input as ended and forbid additional pushes */
  endInput() {
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.flush();
    this.close();
  }

  next(): Promise<IteratorResult<TokenData>> {
    return this.queue.next();
  }

  /** Close both the input and output of the token stream */
  close() {
    this.queue.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): BufferedTokenStream {
    return this;
  }
}

export class BufferedSentenceStream extends SentenceStream {
  #stream: BufferedTokenStream;

  constructor(func: TokenizeFunc, minTokenLength: number, minContextLength: number) {
    super();
    this.#stream = new BufferedTokenStream(func, minTokenLength, minContextLength);
  }

  pushText(text: string) {
    this.#stream.pushText(text);
  }

  flush() {
    this.#stream.flush();
  }

  close() {
    super.close();
    this.#stream.close();
  }

  next(): Promise<IteratorResult<TokenData>> {
    return this.#stream.next();
  }
}

export class BufferedWordStream extends WordStream {
  #stream: BufferedTokenStream;

  constructor(func: TokenizeFunc, minTokenLength: number, minContextLength: number) {
    super();
    this.#stream = new BufferedTokenStream(func, minTokenLength, minContextLength);
  }

  pushText(text: string) {
    this.#stream.pushText(text);
  }

  flush() {
    this.#stream.flush();
  }

  endInput() {
    this.#stream.endInput();
  }

  close() {
    this.#stream.close();
  }

  next(): Promise<IteratorResult<TokenData>> {
    return this.#stream.next();
  }
}
