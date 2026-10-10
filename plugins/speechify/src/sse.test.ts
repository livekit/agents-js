// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { SSEDecoder } from './sse.js';

describe('SSEDecoder', () => {
  it('returns the data of each complete event', () => {
    const decoder = new SSEDecoder();
    expect(
      decoder.push('event: speech.chunk\ndata: {"a":1}\n\nevent: speech.done\ndata: {}\n\n'),
    ).toEqual(['{"a":1}', '{}']);
  });

  it('holds an event split across chunks until it is complete', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: {"a"')).toEqual([]);
    expect(decoder.push(':1}\n')).toEqual([]);
    expect(decoder.push('\n')).toEqual(['{"a":1}']);
  });

  it('accepts CRLF and CR line endings, including a CRLF split across chunks', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: one\r\n\r\ndata: two\r')).toEqual(['one']);
    // The trailing CR may be the first half of a CRLF, so the blank line is not certain yet.
    expect(decoder.push('\n\r')).toEqual([]);
    expect(decoder.push('\ndata: three\r\r\n')).toEqual(['two', 'three']);
  });

  it('joins multi-line data and skips comments and other fields', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push(': keep-alive\nid: 7\ndata: a\ndata:b\nretry: 10\n\n\n')).toEqual(['a\nb']);
  });

  it('drops an event that never ends', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: partial\n')).toEqual([]);
  });
});
