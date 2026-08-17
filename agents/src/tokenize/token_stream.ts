// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue, shortuuid } from '../utils.js';
import type { TokenData } from './tokenizer.js';
import { SentenceStream, WordStream } from './tokenizer.js';

type TokenizeFunc = (x: string) => string[] | [string, number, number][];

// the tag name must start with a letter so "<5>" / "<3 wins>" are not counted as tags —
// this keeps the depth counter consistent with the letter-start tail check in
// hasUnclosedXmlTags (all TTS markup tags are letter-named)
const XML_TAG_RE = /<(\/?)([A-Za-z]\w*)[^>]*?(\/?)\s*>/g;

/** Return true if `text` contains an incomplete or unclosed XML tag. */
export function hasUnclosedXmlTags(text: string): boolean {
  if (!text.includes('<')) return false;

  // incomplete tag at end: a tag-shaped "<" without a matching ">". Only "<" followed by
  // a name start ("/" or a letter) is tag-shaped — a bare "<" as in "3 < 5" or "<3" is
  // plain text and must not hold up streaming. Text ending exactly at "<" is treated as
  // tag-shaped: the next chunk resolves it.
  const lastOpen = text.lastIndexOf('<');
  const lastClose = text.lastIndexOf('>');
  if (lastOpen > lastClose) {
    const nxt = text.slice(lastOpen + 1, lastOpen + 2);
    if (nxt === '' || nxt === '/' || /[a-z]/i.test(nxt)) {
      return true;
    }
  }

  // unbalanced open/close pairs
  let depth = 0;
  for (const match of text.matchAll(XML_TAG_RE)) {
    const isClosing = match[1] === '/';
    const isSelfClosing = match[3] === '/';
    if (isSelfClosing) continue;
    else if (isClosing) depth -= 1;
    else depth += 1;
  }

  return depth > 0;
}

/** Return true if `text` contains XML tags but no substantive text content. */
function isXmlOnly(text: string): boolean {
  if (!text.includes('<')) return false;
  return text.replace(XML_TAG_RE, '').trim().length === 0;
}

/**
 * Map a position in tag-stripped text to the corresponding original position.
 *
 * Tags that sit right at the boundary are left for the next sentence.
 */
function cleanToOrig(cleanPos: number, tagSpans: [number, number][]): number {
  let orig = cleanPos;
  for (const [tagStart, tagEnd] of tagSpans) {
    if (tagStart < orig) {
      orig += tagEnd - tagStart;
    } else {
      break;
    }
  }
  return orig;
}

/**
 * Wrap a tokenizer so XML tags don't interfere with sentence splitting.
 *
 * Strips tag markers before tokenization (content inside wrapping tags is kept so the
 * tokenizer can account for its length), remaps offsets back to the original text, and
 * merges sentences with unclosed or tag-only content.
 */
export function xmlWrapTokenizer(tokenizeFnc: TokenizeFunc): TokenizeFunc {
  const wrappedImpl = (text: string): string[] | [string, number, number][] => {
    const tagSpans: [number, number][] = [];
    for (const match of text.matchAll(XML_TAG_RE)) {
      tagSpans.push([match.index!, match.index! + match[0].length]);
    }
    if (!tagSpans.length) {
      return tokenizeFnc(text);
    }

    const cleanText = text.replace(XML_TAG_RE, '');
    if (!cleanText.trim()) {
      return text.trim() ? [[text, 0, text.length]] : [];
    }

    const rawTokens = tokenizeFnc(cleanText);
    if (!rawTokens.length) {
      return [];
    }

    // extract clean-text end offsets
    let cleanEnds: number[] = rawTokens.map((tok) => (Array.isArray(tok) ? tok[2] : -1));

    // if tokenizer didn't provide offsets, approximate from token lengths
    if (cleanEnds[0] === -1) {
      let pos = 0;
      cleanEnds = [];
      for (const tok of rawTokens) {
        const tokText = Array.isArray(tok) ? tok[0] : tok;
        const idx = cleanText.indexOf(tokText, pos);
        pos = (idx >= 0 ? idx : pos) + tokText.length;
        cleanEnds.push(pos);
      }
    }

    // remap to original positions and rebuild sentences
    let result: [string, number, number][] = [];
    let start = 0;
    for (const cleanEnd of cleanEnds) {
      const origEnd = cleanToOrig(cleanEnd, tagSpans);
      const sentence = text.slice(start, origEnd).trim();
      if (sentence) {
        result.push([sentence, start, origEnd]);
      }
      start = origEnd;
    }

    if (start < text.length) {
      const sentence = text.slice(start).trim();
      if (sentence) {
        result.push([sentence, start, text.length]);
      }
    }

    // merge sentences with unclosed tags or tag-only content
    if (result.length) {
      const merged: [string, number, number][] = [result[0]!];
      for (const [sentText, sStart, sEnd] of result.slice(1)) {
        const [prevText, prevStart] = merged[merged.length - 1]!;
        if (hasUnclosedXmlTags(prevText) || isXmlOnly(prevText)) {
          merged[merged.length - 1] = [text.slice(prevStart, sEnd).trim(), prevStart, sEnd];
        } else {
          merged.push([sentText, sStart, sEnd]);
        }
      }
      result = merged;
    }

    return result;
  };

  return (text: string) => {
    try {
      return wrappedImpl(text);
    } catch {
      return text.trim() ? [[text, 0, text.length] as [string, number, number]] : [];
    }
  };
}

export interface BufferedTokenStreamOptions {
  /**
   * Hard cap on emitted token length; a token is flushed before appending a piece that
   * would exceed it.
   */
  maxTokenLength?: number;
  /**
   * Minimum length for the *first* token of each segment, when it should differ from
   * `minTokenLength`.
   *
   * Batching trades time-to-first-result for larger chunks. Setting this lets the opening
   * token go out as soon as it is ready while later tokens still accumulate to
   * `minTokenLength` — so a consumer that batches pays nothing at the head of a segment.
   * Reset by `flush()`, since each segment gets its own first token.
   */
  firstTokenLength?: number;
  /**
   * Treat XML markup as atomic — never split a tag across tokens and merge
   * tag-only/unclosed spans forward. Only enable when the input actually carries markup
   * (e.g. expressive TTS): a stray "<" in plain text can otherwise hold back streaming
   * until flush.
   */
  xmlAware?: boolean;
}

export class BufferedTokenStream implements AsyncIterableIterator<TokenData> {
  protected queue = new AsyncIterableQueue<TokenData>();
  protected closed = false;

  #func: TokenizeFunc;
  #minTokenLength: number;
  #minContextLength: number;
  #maxTokenLength?: number;
  #firstTokenLength?: number;
  #emittedThisSegment = 0;
  #xmlAware: boolean;
  #inBuf = '';
  #outBuf = '';
  #currentSegmentId: string;

  constructor(
    func: TokenizeFunc,
    minTokenLength: number,
    minContextLength: number,
    options: BufferedTokenStreamOptions = {},
  ) {
    this.#xmlAware = options.xmlAware ?? false;
    this.#func = this.#xmlAware ? xmlWrapTokenizer(func) : func;
    this.#minTokenLength = minTokenLength;
    this.#minContextLength = minContextLength;
    this.#maxTokenLength = options.maxTokenLength;
    this.#firstTokenLength = options.firstTokenLength;

    this.#currentSegmentId = shortuuid();
  }

  /** The length the running token must reach before it is emitted. */
  get #emitThreshold(): number {
    return this.#emittedThisSegment === 0 && this.#firstTokenLength !== undefined
      ? this.#firstTokenLength
      : this.#minTokenLength;
  }

  #emit() {
    this.queue.put({ token: this.#outBuf, segmentId: this.#currentSegmentId });
    this.#outBuf = '';
    this.#emittedThisSegment += 1;
  }

  /** Push a string of text into the token stream */
  pushText(text: string) {
    if (this.closed) {
      throw new Error('Stream is closed');
    }

    if (!text) return;
    this.#inBuf += text;
    if (this.#inBuf.length < this.#minContextLength) return;

    while (true) {
      const tokens = this.#func(this.#inBuf);
      if (tokens.length <= 1) break;

      const tok = tokens[0]!;
      const tokText = Array.isArray(tok) ? tok[0] : tok;

      // don't emit a token that would split an XML tag
      if (this.#xmlAware && hasUnclosedXmlTags(tokText)) break;

      tokens.shift();

      // if adding this sentence would exceed max, emit what we have first
      if (
        this.#maxTokenLength &&
        this.#outBuf &&
        this.#outBuf.length + 1 + tokText.length > this.#maxTokenLength
      ) {
        this.#emit();
      }

      if (this.#outBuf) this.#outBuf += ' ';
      this.#outBuf += tokText;

      if (this.#outBuf.length >= this.#emitThreshold) {
        this.#emit();
      }

      if (Array.isArray(tok)) {
        this.#inBuf = this.#inBuf.slice(tok[2]);
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
      for (const tok of this.#func(this.#inBuf)) {
        const tokText = Array.isArray(tok) ? tok[0] : tok;

        // honor the cap here too: appending everything into one chunk could exceed
        // maxTokenLength and trip a provider's send limit. Emit the buffer before it would
        // overflow, then keep batching the rest.
        if (
          this.#maxTokenLength &&
          this.#outBuf &&
          this.#outBuf.length + 1 + tokText.length > this.#maxTokenLength
        ) {
          this.#emit();
        }

        if (this.#outBuf) this.#outBuf += ' ';
        this.#outBuf += tokText;
      }

      if (this.#outBuf) {
        this.#emit();
      }

      this.#currentSegmentId = shortuuid();
      // a new segment gets its own fast first token
      this.#emittedThisSegment = 0;
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

  constructor(
    func: TokenizeFunc,
    minTokenLength: number,
    minContextLength: number,
    options: BufferedTokenStreamOptions = {},
  ) {
    super();
    this.#stream = new BufferedTokenStream(func, minTokenLength, minContextLength, options);
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

  endInput() {
    this.#stream.endInput();
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
