// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TTS_TEXT_TRANSFORMS,
  applyTextTransforms,
  getAvailableTransforms,
} from './transforms.js';

/**
 * Helper to convert a string to a ReadableStream
 */
function stringToStream(text: string): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

/**
 * Helper to read a stream to a string
 */
async function streamToString(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += value;
  }
  return result;
}

describe('Text Transforms Core', () => {
  it('should export DEFAULT_TTS_TEXT_TRANSFORMS', () => {
    expect(DEFAULT_TTS_TEXT_TRANSFORMS).toBeDefined();
    expect(DEFAULT_TTS_TEXT_TRANSFORMS).toEqual(['filter_markdown', 'filter_emoji']);
  });

  it('should list available transforms for English', () => {
    const transforms = getAvailableTransforms('en');
    expect(transforms.has('filter_markdown')).toBe(true);
    expect(transforms.has('filter_emoji')).toBe(true);
    expect(transforms.has('format_numbers')).toBe(true);
    expect(transforms.has('format_dollar_amounts')).toBe(true);
  });

  it('should list available transforms for German', () => {
    const transforms = getAvailableTransforms('de');
    expect(transforms.has('filter_markdown')).toBe(true);
    expect(transforms.has('filter_emoji')).toBe(true);
    expect(transforms.has('format_numbers_de')).toBe(true);
    expect(transforms.has('format_euro_amounts')).toBe(true);
  });

  it('should throw error for invalid transform name', async () => {
    const stream = stringToStream('test');
    await expect(
      applyTextTransforms(stream, ['invalid_transform' as any], { language: 'en' }),
    ).rejects.toThrow('Invalid transform');
  });

  it('should apply custom transform function', async () => {
    const customTransform = (text: ReadableStream<string>) => {
      return new ReadableStream({
        async start(controller) {
          const reader = text.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              break;
            }
            controller.enqueue(value.toUpperCase());
          }
        },
      });
    };

    const stream = stringToStream('hello world');
    const result = await applyTextTransforms(stream, [customTransform]);
    const output = await streamToString(result);
    expect(output).toBe('HELLO WORLD');
  });

  it('should apply multiple transforms in sequence', async () => {
    const stream = stringToStream('**Price: $5** 🎉');
    const result = await applyTextTransforms(
      stream,
      ['filter_markdown', 'filter_emoji', 'format_dollar_amounts'],
      { language: 'en' },
    );
    const output = await streamToString(result);
    expect(output).toContain('Price:');
    expect(output).toContain('five dollars');
    expect(output).not.toContain('**');
    expect(output).not.toContain('🎉');
  });
});
