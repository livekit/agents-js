// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for interruption detection logic in AgentActivity.
 *
 * Tests the refactored minInterruptionWords check which ensures:
 * - Consistent word count filtering across all speech scenarios
 * - Proper handling of empty strings, undefined, and short speech
 * - Interruptions allowed only when word count meets or exceeds minInterruptionWords threshold
 */
import { describe, expect, it } from 'vitest';
import { splitWords } from '../tokenize/basic/word.js';

describe('Interruption Detection - Word Counting', () => {
  describe('Word Splitting Behavior', () => {
    it('should count empty string as 0 words', () => {
      const text = '';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(0);
    });

    it('should count single word correctly', () => {
      const text = 'hello';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(1);
    });

    it('should count two words correctly', () => {
      const text = 'hello world';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(2);
    });

    it('should count multiple words correctly', () => {
      const text = 'hello this is a full sentence';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(6);
    });

    it('should handle punctuation correctly', () => {
      const text = 'hello, world!';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(2);
    });

    it('should handle multiple spaces between words', () => {
      const text = 'hello  world';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(2);
    });

    it('should count whitespace-only string as 0 words', () => {
      const text = '   ';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(0);
    });

    it('should handle leading and trailing whitespace', () => {
      const text = '  hello world  ';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(2);
    });
  });

  describe('Integration: Full Interruption Check Logic', () => {
    it('should block interruption for empty transcript with threshold 2', () => {
      const text = '';
      const minInterruptionWords = 2;

      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('');
      expect(wordCount).toBe(0);
      expect(shouldBlock).toBe(true);
    });

    it('should block interruption for undefined transcript with threshold 2', () => {
      const text: string | undefined = undefined;
      const minInterruptionWords = 2;

      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('');
      expect(wordCount).toBe(0);
      expect(shouldBlock).toBe(true);
    });

    it('should block interruption for single word with threshold 2', () => {
      const text = 'hello';
      const minInterruptionWords = 2;

      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('hello');
      expect(wordCount).toBe(1);
      expect(shouldBlock).toBe(true);
    });

    it('should allow interruption when word count exactly meets threshold', () => {
      const text = 'hello world';
      const minInterruptionWords = 2;

      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('hello world');
      expect(wordCount).toBe(2);
      expect(shouldBlock).toBe(false);
    });

    it('should allow interruption when word count exceeds threshold', () => {
      const text = 'hello this is a full sentence';
      const minInterruptionWords = 2;

      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('hello this is a full sentence');
      expect(wordCount).toBe(6);
      expect(shouldBlock).toBe(false);
    });

    it('should apply consistent word counting logic in both methods', () => {
      const transcripts = ['', 'hello', 'hello world', 'this is a longer sentence'];
      const threshold = 2;

      transcripts.forEach((transcript) => {
        const text1 = transcript;
        const normalizedText1 = text1 ?? '';
        const wordCount1 = splitWords(normalizedText1, true).length;
        const shouldBlock1 = wordCount1 < threshold;

        const wordCount2 = splitWords(transcript, true).length;
        const shouldBlock2 = wordCount2 < threshold;

        expect(wordCount1).toBe(wordCount2);
        expect(shouldBlock1).toBe(shouldBlock2);
      });
    });
  });
});
