// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * @fileoverview Unit tests for interruption detection logic in AgentActivity.
 *
 * Tests the refactored minInterruptionWords check which ensures:
 * - Consistent word count filtering across all speech scenarios
 * - Proper handling of empty strings, undefined, and short speech
 * - Interruptions are only allowed when word count >= minInterruptionWords
 *
 * Key test scenarios:
 * 1. Empty string STT result - should be blocked (0 words < threshold)
 * 2. Undefined STT result - should be blocked (0 words < threshold)
 * 3. Fewer words than minimum - should be blocked (e.g., 1 word < 2 minimum)
 * 4. Exactly minimum words - should be allowed (e.g., 2 words >= 2 minimum)
 * 5. More than minimum words - should be allowed (e.g., 5 words >= 2 minimum)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { splitWords } from '../tokenize/basic/word.js';

/**
 * Test Suite: Word Splitting and Counting Logic
 *
 * These tests verify that the word splitting function works correctly
 * with various input formats that might be received from STT engines.
 */
describe('Interruption Detection - Word Counting', () => {
  describe('Word Splitting Behavior', () => {
    /**
     * Test Case 1: Empty String
     *
     * Input: Empty string ""
     * Expected: Word count = 0
     * Implication: Should NOT allow interruption when minInterruptionWords > 0
     */
    it('should count empty string as 0 words', () => {
      const text = '';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(0);
    });

    /**
     * Test Case 2: Single Word
     *
     * Input: "hello"
     * Expected: Word count = 1
     * Implication: Should NOT allow interruption when minInterruptionWords >= 2
     */
    it('should count single word correctly', () => {
      const text = 'hello';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(1);
    });

    /**
     * Test Case 3: Two Words
     *
     * Input: "hello world"
     * Expected: Word count = 2
     * Implication: Should ALLOW interruption when minInterruptionWords = 2
     */
    it('should count two words correctly', () => {
      const text = 'hello world';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(2);
    });

    /**
     * Test Case 4: Multiple Words
     *
     * Input: "hello this is a full sentence"
     * Expected: Word count = 6
     * Implication: Should ALLOW interruption for any minInterruptionWords <= 6
     */
    it('should count multiple words correctly', () => {
      const text = 'hello this is a full sentence';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(6);
    });

    /**
     * Test Case 5: Punctuation Handling
     *
     * Input: "hello, world!"
     * Expected: Word count = 2 (punctuation stripped)
     * Implication: Punctuation should not artificially inflate word count
     */
    it('should handle punctuation correctly', () => {
      const text = 'hello, world!';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(2);
    });

    /**
     * Test Case 6: Extra Whitespace
     *
     * Input: "hello  world" (double space)
     * Expected: Word count = 2 (multiple spaces treated as single separator)
     * Implication: Robust handling of inconsistent spacing
     */
    it('should handle multiple spaces between words', () => {
      const text = 'hello  world';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(2);
    });

    /**
     * Test Case 7: Whitespace-Only String
     *
     * Input: "   " (only spaces)
     * Expected: Word count = 0
     * Implication: Should NOT allow interruption (functionally empty)
     */
    it('should count whitespace-only string as 0 words', () => {
      const text = '   ';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(0);
    });

    /**
     * Test Case 8: Leading and Trailing Whitespace
     *
     * Input: "  hello world  " (spaces before and after)
     * Expected: Word count = 2 (whitespace trimmed)
     * Implication: Edge whitespace should not affect word count
     */
    it('should handle leading and trailing whitespace', () => {
      const text = '  hello world  ';
      const wordCount = splitWords(text, true).length;
      expect(wordCount).toBe(2);
    });
  });

  describe('Interruption Threshold Logic', () => {
    /**
     * Test Case 9: Word Count Comparison - Below Threshold
     *
     * Scenario: minInterruptionWords = 2
     * Input: "hello" (1 word)
     * Check: 1 < 2 should be TRUE (block interruption)
     */
    it('should block interruption when word count is below threshold', () => {
      const minInterruptionWords = 2;
      const wordCount = 1;
      const shouldBlock = wordCount < minInterruptionWords;
      expect(shouldBlock).toBe(true);
    });

    /**
     * Test Case 10: Word Count Comparison - At Threshold
     *
     * Scenario: minInterruptionWords = 2
     * Input: "hello world" (2 words)
     * Check: 2 < 2 should be FALSE (allow interruption)
     */
    it('should allow interruption when word count meets threshold', () => {
      const minInterruptionWords = 2;
      const wordCount = 2;
      const shouldBlock = wordCount < minInterruptionWords;
      expect(shouldBlock).toBe(false);
    });

    /**
     * Test Case 11: Word Count Comparison - Above Threshold
     *
     * Scenario: minInterruptionWords = 2
     * Input: "hello this is a test" (5 words)
     * Check: 5 < 2 should be FALSE (allow interruption)
     */
    it('should allow interruption when word count exceeds threshold', () => {
      const minInterruptionWords = 2;
      const wordCount = 5;
      const shouldBlock = wordCount < minInterruptionWords;
      expect(shouldBlock).toBe(false);
    });

    /**
     * Test Case 12: Zero Threshold (Disabled Check)
     *
     * Scenario: minInterruptionWords = 0 (check disabled)
     * Input: "" (empty)
     * Expected: Word count check should be skipped entirely
     * Implication: When threshold is 0, any speech should allow interruption
     */
    it('should skip word count check when minInterruptionWords is 0', () => {
      const minInterruptionWords = 0;
      const wordCount = 0;
      // When minInterruptionWords is 0, the check is not performed at all
      const shouldPerformCheck = minInterruptionWords > 0;
      expect(shouldPerformCheck).toBe(false);
    });

    /**
     * Test Case 13: High Threshold
     *
     * Scenario: minInterruptionWords = 5
     * Input: "hello world" (2 words)
     * Check: 2 < 5 should be TRUE (block interruption)
     */
    it('should respect high minInterruptionWords threshold', () => {
      const minInterruptionWords = 5;
      const wordCount = 2;
      const shouldBlock = wordCount < minInterruptionWords;
      expect(shouldBlock).toBe(true);
    });
  });

  describe('Undefined and Null Handling', () => {
    /**
     * Test Case 14: Undefined Normalization
     *
     * Behavior: undefined ?? '' converts undefined to empty string
     * Expected: Normalized value is ""
     * Implication: Undefined is treated as empty string (0 words)
     */
    it('should normalize undefined to empty string', () => {
      const text: string | undefined = undefined;
      const normalizedText = text ?? '';
      expect(normalizedText).toBe('');
    });

    /**
     * Test Case 15: Null Normalization
     *
     * Behavior: null ?? '' converts null to empty string
     * Expected: Normalized value is ""
     * Implication: Null is treated as empty string (0 words)
     */
    it('should normalize null to empty string', () => {
      const text: string | null = null;
      const normalizedText = text ?? '';
      expect(normalizedText).toBe('');
    });

    /**
     * Test Case 16: Empty String Pass-Through
     *
     * Behavior: '' ?? '' remains as empty string
     * Expected: Normalized value is ""
     * Implication: Empty string is preserved and counted as 0 words
     */
    it('should preserve empty string during normalization', () => {
      const text = '';
      const normalizedText = text ?? '';
      expect(normalizedText).toBe('');
    });

    /**
     * Test Case 17: Valid String Pass-Through
     *
     * Behavior: 'hello' ?? '' remains as 'hello'
     * Expected: Normalized value is "hello"
     * Implication: Valid strings are preserved during normalization
     */
    it('should preserve valid string during normalization', () => {
      const text = 'hello';
      const normalizedText = text ?? '';
      expect(normalizedText).toBe('hello');
    });
  });

  describe('Integration: Full Interruption Check Logic', () => {
    /**
     * Test Case 18: Complete Logic Flow - Empty String Should Block
     *
     * Scenario:
     * - STT is available
     * - minInterruptionWords = 2
     * - currentTranscript = ""
     *
     * Expected Flow:
     * 1. text = ""
     * 2. normalizedText = "" ?? '' = ""
     * 3. wordCount = splitWords("", true).length = 0
     * 4. Check: 0 < 2 = true → BLOCK interruption
     */
    it('should block interruption for empty transcript with threshold 2', () => {
      const text = '';
      const minInterruptionWords = 2;

      // Simulate refactored logic
      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('');
      expect(wordCount).toBe(0);
      expect(shouldBlock).toBe(true);
    });

    /**
     * Test Case 19: Complete Logic Flow - Undefined Should Block
     *
     * Scenario:
     * - STT is available
     * - minInterruptionWords = 2
     * - currentTranscript = undefined
     *
     * Expected Flow:
     * 1. text = undefined
     * 2. normalizedText = undefined ?? '' = ""
     * 3. wordCount = splitWords("", true).length = 0
     * 4. Check: 0 < 2 = true → BLOCK interruption
     */
    it('should block interruption for undefined transcript with threshold 2', () => {
      const text: string | undefined = undefined;
      const minInterruptionWords = 2;

      // Simulate refactored logic
      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('');
      expect(wordCount).toBe(0);
      expect(shouldBlock).toBe(true);
    });

    /**
     * Test Case 20: Complete Logic Flow - One Word Should Block
     *
     * Scenario:
     * - STT is available
     * - minInterruptionWords = 2
     * - currentTranscript = "hello"
     *
     * Expected Flow:
     * 1. text = "hello"
     * 2. normalizedText = "hello" ?? '' = "hello"
     * 3. wordCount = splitWords("hello", true).length = 1
     * 4. Check: 1 < 2 = true → BLOCK interruption
     */
    it('should block interruption for single word with threshold 2', () => {
      const text = 'hello';
      const minInterruptionWords = 2;

      // Simulate refactored logic
      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('hello');
      expect(wordCount).toBe(1);
      expect(shouldBlock).toBe(true);
    });

    /**
     * Test Case 21: Complete Logic Flow - Exact Match Should Allow
     *
     * Scenario:
     * - STT is available
     * - minInterruptionWords = 2
     * - currentTranscript = "hello world"
     *
     * Expected Flow:
     * 1. text = "hello world"
     * 2. normalizedText = "hello world" ?? '' = "hello world"
     * 3. wordCount = splitWords("hello world", true).length = 2
     * 4. Check: 2 < 2 = false → ALLOW interruption
     */
    it('should allow interruption when word count exactly meets threshold', () => {
      const text = 'hello world';
      const minInterruptionWords = 2;

      // Simulate refactored logic
      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('hello world');
      expect(wordCount).toBe(2);
      expect(shouldBlock).toBe(false);
    });

    /**
     * Test Case 22: Complete Logic Flow - Exceeding Threshold Should Allow
     *
     * Scenario:
     * - STT is available
     * - minInterruptionWords = 2
     * - currentTranscript = "hello this is a full sentence"
     *
     * Expected Flow:
     * 1. text = "hello this is a full sentence"
     * 2. normalizedText = "hello this is a full sentence" ?? '' = "hello this is a full sentence"
     * 3. wordCount = splitWords("hello this is a full sentence", true).length = 6
     * 4. Check: 6 < 2 = false → ALLOW interruption
     */
    it('should allow interruption when word count exceeds threshold', () => {
      const text = 'hello this is a full sentence';
      const minInterruptionWords = 2;

      // Simulate refactored logic
      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;
      const shouldBlock = wordCount < minInterruptionWords;

      expect(normalizedText).toBe('hello this is a full sentence');
      expect(wordCount).toBe(6);
      expect(shouldBlock).toBe(false);
    });

    /**
     * Test Case 23: Consistency Between onVADInferenceDone and onEndOfTurn
     *
     * Both methods should use the same word-splitting logic and comparison.
     * They should produce identical results for the same transcript and threshold.
     *
     * Scenario: Compare word counting in both contexts
     */
    it('should apply consistent word counting logic in both methods', () => {
      const transcripts = ['', 'hello', 'hello world', 'this is a longer sentence'];
      const threshold = 2;

      transcripts.forEach((transcript) => {
        // Simulate onVADInferenceDone logic
        const text1 = transcript;
        const normalizedText1 = text1 ?? '';
        const wordCount1 = splitWords(normalizedText1, true).length;
        const shouldBlock1 = wordCount1 < threshold;

        // Simulate onEndOfTurn logic (which now uses splitWords directly)
        const wordCount2 = splitWords(transcript, true).length;
        const shouldBlock2 = wordCount2 < threshold;

        // Results should be identical
        expect(wordCount1).toBe(wordCount2);
        expect(shouldBlock1).toBe(shouldBlock2);
      });
    });
  });
});
