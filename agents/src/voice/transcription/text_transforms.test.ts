// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { applyTextTransforms, replace } from './text_transforms.js';

function streamText(text: string, chunkSize: number): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) {
        controller.enqueue(text.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += value;
    }
  } finally {
    reader.releaseLock();
  }
  return result;
}

describe('textTransforms.replace', () => {
  for (const chunkSize of [1, 2, 5, 11, 50]) {
    it(`replaces across chunk size ${chunkSize}`, async () => {
      const transform = replace({ LiveKit: 'Lyve Kit', SQL: 'sequel', boundary: 'EDGE' });
      const result = await collect(
        transform(streamText('LiveKit uses SQL. livekit boundary test.', chunkSize)),
      );
      expect(result).toBe('Lyve Kit uses sequel. Lyve Kit EDGE test.');
    });
  }

  for (const chunkSize of [1, 3, 7]) {
    it(`supports case-sensitive replacement with chunk size ${chunkSize}`, async () => {
      const transform = replace({ LiveKit: 'Lyve Kit' }, { caseSensitive: true });
      const result = await collect(
        transform(streamText('LiveKit is great. livekit should stay.', chunkSize)),
      );
      expect(result).toBe('Lyve Kit is great. livekit should stay.');
    });
  }

  it('handles edge cases', async () => {
    expect(await collect(replace({})(streamText('Hello world.', 3)))).toBe('Hello world.');
    expect(await collect(replace({ foo: 'bar' })(streamText('', 1)))).toBe('');
    expect(await collect(replace({ xyz: 'abc' })(streamText('Hello world.', 4)))).toBe(
      'Hello world.',
    );
    expect(
      await collect(
        replace({ 'C++': 'cpp', 'file.txt': 'file_txt' })(
          streamText('Use C++ to read file.txt', 2),
        ),
      ),
    ).toBe('Use cpp to read file_txt');
    expect(
      await collect(replace({ word: String.raw`\1 \n \t` })(streamText('a word here', 2))),
    ).toBe(String.raw`a \1 \n \t here`);
  });

  it('applies callable and built-in transforms', async () => {
    expect(
      await collect(
        applyTextTransforms(streamText('Hello world!', 3), [replace({ world: 'planet' })]),
      ),
    ).toBe('Hello planet!');

    expect(
      await collect(
        applyTextTransforms(streamText('**hello** world! 😀', 3), [
          'filter_markdown',
          replace({ hello: 'hi' }),
          'filter_emoji',
        ]),
      ),
    ).toBe('hi world! ');

    expect(() => applyTextTransforms(streamText('text', 4), ['nonexistent' as never])).toThrow(
      /Invalid transform/,
    );
  });
});
