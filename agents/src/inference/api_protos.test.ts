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

  it('normalizes null transcript words to an empty array', () => {
    const result = sttServerEventSchema.safeParse({
      type: 'final_transcript',
      session_id: 's1',
      transcript: 'Hello? Can you hear me?',
      start: 0,
      duration: 0,
      confidence: 1,
      words: null,
      language: 'en-US',
      extra: {
        voice_profile: {
          gender: [{ confidence: 0.73, label: 'male' }],
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'final_transcript') {
      expect(result.data.words).toEqual([]);
      expect(result.data.extra).toEqual({
        voice_profile: {
          gender: [{ confidence: 0.73, label: 'male' }],
        },
      });
    }
  });
});

describe('ttsServerEventSchema', () => {
  it('extracts output_alignment words payload', () => {
    const result = ttsServerEventSchema.safeParse({
      type: 'output_alignment',
      session_id: 's1',
      words: [
        { word: 'hello', start: 0.1, end: 0.4 },
        { word: 'world', start: 0.4, end: 0.8 },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'output_alignment') {
      const data = result.data as {
        session_id?: string;
        words?: Array<{ word: string }>;
        chars?: Array<{ char: string }>;
      };
      expect(data.session_id).toBe('s1');
      expect(data.words?.map((w) => w.word)).toEqual(['hello', 'world']);
      expect(data.chars).toBeUndefined();
    }
  });

  it('extracts output_alignment chars payload', () => {
    const result = ttsServerEventSchema.safeParse({
      type: 'output_alignment',
      session_id: 's2',
      chars: [
        { char: 'h', start: 0.1, end: 0.2 },
        { char: 'i', start: 0.2, end: 0.3 },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'output_alignment') {
      const data = result.data as {
        session_id?: string;
        words?: Array<{ word: string }>;
        chars?: Array<{ char: string }>;
      };
      expect(data.session_id).toBe('s2');
      expect(data.chars?.map((c) => c.char)).toEqual(['h', 'i']);
      expect(data.words).toBeUndefined();
    }
  });

  it('rejects malformed output_alignment entries', () => {
    const result = ttsServerEventSchema.safeParse({
      type: 'output_alignment',
      session_id: 's3',
      words: [{ word: 'oops', start: 'bad', end: 0.2 }],
    });

    expect(result.success).toBe(false);
  });
});
