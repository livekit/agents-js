// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { sttServerEventSchema, ttsServerEventSchema } from './api_protos.js';

describe('sttServerEventSchema', () => {
  it('accepts numeric error codes from STT server events', () => {
    const result = sttServerEventSchema.safeParse({
      type: 'error',
      message: 'rate limited',
      code: 429,
    });

    expect(result.success).toBe(true);
  });
});

describe('ttsServerEventSchema', () => {
  it('extracts output_timestamps words payload', () => {
    const result = ttsServerEventSchema.safeParse({
      type: 'output_timestamps',
      session_id: 's1',
      words: [
        { word: 'hello', start: 0.1, end: 0.4 },
        { word: 'world', start: 0.4, end: 0.8 },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('output_timestamps');
      expect(result.data.session_id).toBe('s1');
      expect(result.data.words?.map((w) => w.word)).toEqual(['hello', 'world']);
      expect(result.data.chars).toBeUndefined();
    }
  });

  it('extracts output_timestamps chars payload', () => {
    const result = ttsServerEventSchema.safeParse({
      type: 'output_timestamps',
      session_id: 's2',
      chars: [
        { char: 'h', start: 0.1, end: 0.2 },
        { char: 'i', start: 0.2, end: 0.3 },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('output_timestamps');
      expect(result.data.session_id).toBe('s2');
      expect(result.data.chars?.map((c) => c.char)).toEqual(['h', 'i']);
      expect(result.data.words).toBeUndefined();
    }
  });

  it('rejects malformed output_timestamps entries', () => {
    const result = ttsServerEventSchema.safeParse({
      type: 'output_timestamps',
      session_id: 's3',
      words: [{ word: 'oops', start: 'bad', end: 0.2 }],
    });

    expect(result.success).toBe(false);
  });
});
