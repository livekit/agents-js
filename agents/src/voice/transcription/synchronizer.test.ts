// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { SpeakingRateData } from './synchronizer.js';

describe('SpeakingRateData', () => {
  describe('constructor', () => {
    it('should initialize with empty arrays', () => {
      const data = new SpeakingRateData();
      expect(data.timestamps).toEqual([]);
      expect(data.speakingRate).toEqual([]);
      expect(data.speakIntegrals).toEqual([]);
      expect(data.pushedDuration).toBe(0);
    });
  });

  describe('addByRate', () => {
    it('should add a single rate entry', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 5.0);

      expect(data.timestamps).toEqual([1.0]);
      expect(data.speakingRate).toEqual([5.0]);
      // integral = 0 + 5.0 * (1.0 - 0) = 5.0
      expect(data.speakIntegrals).toEqual([5.0]);
      expect(data.pushedDuration).toBe(1.0);
    });

    it('should accumulate integrals across multiple entries', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 4.0); // integral = 0 + 4.0 * 1.0 = 4.0
      data.addByRate(2.0, 6.0); // integral = 4.0 + 6.0 * 1.0 = 10.0
      data.addByRate(3.5, 2.0); // integral = 10.0 + 2.0 * 1.5 = 13.0

      expect(data.timestamps).toEqual([1.0, 2.0, 3.5]);
      expect(data.speakingRate).toEqual([4.0, 6.0, 2.0]);
      expect(data.speakIntegrals).toEqual([4.0, 10.0, 13.0]);
      expect(data.pushedDuration).toBe(3.5);
    });

    it('should handle zero rate', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 0.0);

      expect(data.timestamps).toEqual([1.0]);
      expect(data.speakingRate).toEqual([0.0]);
      expect(data.speakIntegrals).toEqual([0.0]);
    });
  });

  describe('addByAnnotation', () => {
    it('should buffer text without startTime', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('hello', undefined, undefined);

      // Text is buffered, no timestamp entry yet
      expect(data.timestamps).toEqual([]);
      expect(data.pushedDuration).toBe(0);
    });

    it('should add entry when startTime is provided', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('hello', undefined, undefined); // buffer "hello"
      data.addByAnnotation('world', 1.0, undefined); // flush with startTime

      expect(data.timestamps).toEqual([1.0]);
      // textLen = 5 (hello), dt = 1.0, rate = 5/1 = 5.0
      expect(data.speakingRate).toEqual([5.0]);
      expect(data.speakIntegrals).toEqual([5.0]);
    });

    it('should handle startTime and endTime together', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('hello ', 0.0, 0.5);
      data.addByAnnotation('world', 0.5, 1.0);

      // First annotation: startTime=0.0, text="hello ", then recursively calls with endTime=0.5
      // Second annotation: startTime=0.5, text="world", then recursively calls with endTime=1.0
      expect(data.timestamps.length).toBeGreaterThanOrEqual(2);
      expect(data.pushedDuration).toBe(1.0);
    });

    it('should calculate rate based on buffered text length', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('ab', undefined, undefined); // buffer 2 chars
      data.addByAnnotation('cde', undefined, undefined); // buffer 3 more chars
      data.addByAnnotation('', 2.0, undefined); // flush: textLen=5, dt=2.0, rate=2.5

      expect(data.timestamps).toEqual([2.0]);
      expect(data.speakingRate).toEqual([2.5]);
      expect(data.speakIntegrals).toEqual([5.0]);
    });

    it('should handle zero time delta gracefully', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('hello', 0.0, undefined); // dt=0, rate should be 0

      expect(data.timestamps).toEqual([0.0]);
      expect(data.speakingRate).toEqual([0.0]);
      expect(data.speakIntegrals).toEqual([0.0]);
    });
  });

  describe('accumulateTo', () => {
    it('should return 0 for empty data', () => {
      const data = new SpeakingRateData();
      expect(data.accumulateTo(1.0)).toBe(0);
    });

    it('should return 0 for timestamp before first entry', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 5.0);
      expect(data.accumulateTo(0.5)).toBe(0);
    });

    it('should return exact integral at timestamp', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 4.0); // integral = 4.0
      data.addByRate(2.0, 6.0); // integral = 10.0

      expect(data.accumulateTo(1.0)).toBe(4.0);
      expect(data.accumulateTo(2.0)).toBe(10.0);
    });

    it('should interpolate between timestamps', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 4.0); // integral = 4.0
      data.addByRate(2.0, 6.0); // integral = 10.0

      // At 1.5: integral = 4.0 + 6.0 * 0.5 = 7.0
      expect(data.accumulateTo(1.5)).toBe(7.0);
    });

    it('should extrapolate beyond last timestamp', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 4.0); // integral = 4.0
      data.addByRate(2.0, 6.0); // integral = 10.0

      // At 3.0: integral = 10.0 + 6.0 * 1.0 = 16.0
      expect(data.accumulateTo(3.0)).toBe(16.0);
    });

    it('should not exceed next integral when interpolating', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 100.0); // integral = 100.0 (very high rate)
      data.addByRate(2.0, 1.0); // integral = 101.0

      // At 1.5 with rate 1.0: would be 100.0 + 1.0 * 0.5 = 100.5
      // But capped at next integral 101.0, so result is min(100.5, 101.0) = 100.5
      expect(data.accumulateTo(1.5)).toBe(100.5);
    });
  });

  describe('pushedDuration', () => {
    it('should return 0 when empty', () => {
      const data = new SpeakingRateData();
      expect(data.pushedDuration).toBe(0);
    });

    it('should return last timestamp', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 5.0);
      data.addByRate(2.5, 3.0);
      data.addByRate(4.0, 7.0);

      expect(data.pushedDuration).toBe(4.0);
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical TTS word timing scenario', () => {
      const data = new SpeakingRateData();

      // Simulating words with timing: "Hello " at 0-0.3s, "world" at 0.3-0.6s
      data.addByAnnotation('Hello ', 0.0, 0.3);
      data.addByAnnotation('world', 0.3, 0.6);

      // Should have accumulated text lengths at each timestamp
      expect(data.pushedDuration).toBe(0.6);

      // At 0.15s (middle of first word), should be partway through
      const mid1 = data.accumulateTo(0.15);
      expect(mid1).toBeGreaterThan(0);
      expect(mid1).toBeLessThan(6); // "Hello " is 6 chars

      // At 0.45s (middle of second word), should be past first word
      const mid2 = data.accumulateTo(0.45);
      expect(mid2).toBeGreaterThan(6);
    });

    it('should handle mixed rate and annotation data', () => {
      const data = new SpeakingRateData();

      // Start with rate-based data
      data.addByRate(0.5, 4.0); // integral = 2.0

      // Then add annotation
      data.addByAnnotation('test', undefined, undefined);
      data.addByAnnotation('', 1.0, undefined); // textLen=4, dt=0.5, rate=8.0, integral = 2.0 + 4.0 = 6.0

      expect(data.timestamps).toEqual([0.5, 1.0]);
      expect(data.speakIntegrals).toEqual([2.0, 6.0]);
    });
  });
});
