// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createStreamChannel } from './stream_channel.js';

describe('StreamChannel', () => {
  it('should write and read a single value', async () => {
    const channel = createStreamChannel<string>();
    const reader = channel.stream().getReader();

    await channel.write('test value');
    await channel.close();

    const result = await reader.read();
    expect(result.done).toBe(false);
    expect(result.value).toBe('test value');

    const nextResult = await reader.read();
    expect(nextResult.done).toBe(true);
  });

  it('should write and read multiple values in sequence', async () => {
    const channel = createStreamChannel<string>();
    const reader = channel.stream().getReader();

    const testValues = ['first', 'second', 'third'];

    for (const value of testValues) {
      await channel.write(value);
    }
    await channel.close();

    const results: string[] = [];
    let result = await reader.read();
    while (!result.done) {
      results.push(result.value);
      result = await reader.read();
    }

    expect(results).toEqual(testValues);
  });

  it('should handle arrays', async () => {
    const channel = createStreamChannel<number[]>();
    const reader = channel.stream().getReader();

    const testArray = [1, 2, 3, 4, 5];
    await channel.write(testArray);
    await channel.close();

    const result = await reader.read();
    expect(result.value).toEqual(testArray);
    expect(result.value).toBe(testArray);
  });

  it('should work with concurrent writing and reading', async () => {
    const channel = createStreamChannel<string>();
    const reader = channel.stream().getReader();

    const testData = ['chunk1', 'chunk2', 'chunk3'];
    const results: string[] = [];

    const readPromise = (async () => {
      let result = await reader.read();
      while (!result.done) {
        results.push(result.value);
        result = await reader.read();
      }
    })();

    for (const chunk of testData) {
      await channel.write(chunk);
    }
    await channel.close();

    await readPromise;
    expect(results).toEqual(testData);
  });

  it('should handle empty stream', async () => {
    const channel = createStreamChannel<string>();
    const reader = channel.stream().getReader();

    await channel.close();

    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  it('should handle non-awaited sequential writes', async () => {
    const channel = createStreamChannel<number>();
    const reader = channel.stream().getReader();

    const testNumbers = Array.from({ length: 100 }, (_, i) => i);

    for (const num of testNumbers) {
      channel.write(num);
    }
    channel.close();

    const results: number[] = [];
    let result = await reader.read();
    while (!result.done) {
      results.push(result.value);
      result = await reader.read();
    }

    expect(results).toEqual(testNumbers);
  });

  it('should handle double closing without error', async () => {
    const channel = createStreamChannel<string>();
    const reader = channel.stream().getReader();

    await channel.write('test');

    await channel.close();
    // Close again - should not throw
    await expect(channel.close()).resolves.toBeUndefined();

    const result = await reader.read();
    expect(result.done).toBe(false);
    expect(result.value).toBe('test');

    const nextResult = await reader.read();
    expect(nextResult.done).toBe(true);
  });

  it('should gracefully handle close while read is pending', async () => {
    const channel = createStreamChannel<string>();
    const reader = channel.stream().getReader();

    const readPromise = reader.read();

    await channel.close();

    const result = await readPromise;
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('should complete all pending reads when closed', async () => {
    const channel = createStreamChannel<number>();
    const reader = channel.stream().getReader();

    const read1 = reader.read();
    const read2 = reader.read();
    const read3 = reader.read();

    await channel.write(42);
    await channel.write(43);
    await channel.close();

    const result1 = await read1;
    expect(result1.done).toBe(false);
    expect(result1.value).toBe(42);

    const result2 = await read2;
    expect(result2.done).toBe(false);
    expect(result2.value).toBe(43);

    const result3 = await read3;
    expect(result3.done).toBe(true);
  });
});
