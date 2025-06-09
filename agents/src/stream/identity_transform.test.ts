// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { IdentityTransform } from './identity_transform.js';

describe('IdentityTransform', () => {
  it('should handle stream with one value', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const inputValue = 'single value';

    await writer.write(inputValue);
    await writer.close();

    const result = await reader.read();
    expect(result.done).toBe(false);
    expect(result.value).toBe(inputValue);

    const nextResult = await reader.read();
    expect(nextResult.done).toBe(true);
  });

  it('should handle multiple values in sequence', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const inputValues = ['first', 'second', 'third'];

    // Write all values
    for (const value of inputValues) {
      await writer.write(value);
    }
    await writer.close();

    // Read all values
    const results: string[] = [];
    let result = await reader.read();
    while (!result.done) {
      results.push(result.value);
      result = await reader.read();
    }

    expect(results).toEqual(inputValues);
  });

  it('should handle null and undefined values', async () => {
    const transform = new IdentityTransform<string | null | undefined>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const inputValues = ['test', null, undefined, 'another'];

    // Write all values
    for (const value of inputValues) {
      await writer.write(value);
    }
    await writer.close();

    // Read all values
    const results: (string | null | undefined)[] = [];
    let result = await reader.read();
    while (!result.done) {
      results.push(result.value);
      result = await reader.read();
    }

    expect(results).toEqual(inputValues);
  });

  it('should handle arrays', async () => {
    const transform = new IdentityTransform<number[]>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const inputValue = [1, 2, 3, 4, 5];

    await writer.write(inputValue);
    await writer.close();

    const result = await reader.read();

    expect(result.done).toBe(false);
    expect(result.value).toEqual(inputValue);
    expect(result.value).toBe(inputValue); // Should be the same reference

    const nextResult = await reader.read();
    expect(nextResult.done).toBe(true);
  });

  it('should work with streamed data', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const testData = ['chunk1', 'chunk2', 'chunk3'];

    // Write data asynchronously to simulate streaming
    const writePromise = (async () => {
      for (const chunk of testData) {
        await writer.write(chunk);
      }
      await writer.close();
    })();

    // Read data as it comes through
    const results: string[] = [];
    let result = await reader.read();
    while (!result.done) {
      results.push(result.value);
      result = await reader.read();
    }

    await writePromise;
    expect(results).toEqual(testData);
  });

  it('should handle empty stream', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    // Close immediately without writing anything
    await writer.close();

    // Should immediately be done
    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  it('should handle writer closing while reading is in progress', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const testData = ['chunk1', 'chunk2', 'chunk3'];
    const results: string[] = [];

    // Start writing some data
    await writer.write(testData[0]);
    await writer.write(testData[1]);

    // Start reading concurrently
    const readPromise = (async () => {
      let result = await reader.read();
      while (!result.done) {
        results.push(result.value);
        result = await reader.read();
      }
    })();

    // Write one more chunk and then close the writer while reading
    await writer.write(testData[2]);
    await writer.close();

    // Wait for reading to complete
    await readPromise;

    // Should have received all the data
    expect(results).toEqual(testData);
  });

  it('should handle a pending read when the writer is closed', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();

    const readPromise = reader.read();

    await writer.close();

    const result = await readPromise;
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });
});
