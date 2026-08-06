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

function streamChunks(chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
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

async function collectChunks(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const result: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result.push(value);
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

  it('flushes non-prefix text immediately', async () => {
    const transform = replace({ LiveKit: 'Lyve Kit' });
    const chunks = await collectChunks(transform(streamText('you connect.', 100)));
    expect(chunks).toEqual(['you connect.']);
  });

  it('preserves no-match source chunk topology', async () => {
    const transform = replace({ LiveKit: 'Lyve Kit' });
    expect(await collectChunks(transform(streamChunks(['you connect.'])))).toEqual([
      'you connect.',
    ]);
    expect(await collectChunks(transform(streamChunks(['you con', 'nect.'])))).toEqual([
      'you con',
      'nect.',
    ]);
  });

  it('holds only potential prefix', async () => {
    const transform = replace({ LiveKit: 'Lyve Kit' });
    const chunks = await collectChunks(transform(streamText('visit Live', 100)));
    expect(chunks[0]).toBe('visit ');
    expect(chunks.join('')).toBe('visit Live');
  });

  it('completes or rejects a held prefix with the next source chunk', async () => {
    const transform = replace({ LiveKit: 'Lyve Kit' });
    expect(await collectChunks(transform(streamChunks(['visit Live', 'Kit now'])))).toEqual([
      'visit ',
      'Lyve Kit now',
    ]);
    expect(await collectChunks(transform(streamChunks(['visit Live', 'ly now'])))).toEqual([
      'visit ',
      'Lively now',
    ]);
  });

  it('holds whitespace prefixes and flushes unresolved source only at EOF', async () => {
    const whitespaceTransform = replace({ '\nLive': ' START' });
    expect(await collectChunks(whitespaceTransform(streamChunks(['ready\n', 'Live!'])))).toEqual([
      'ready',
      ' START!',
    ]);

    const unresolvedTransform = replace({ LiveKit: 'Lyve Kit' });
    expect(await collectChunks(unresolvedTransform(streamChunks(['visit Live'])))).toEqual([
      'visit ',
      'Live',
    ]);
  });

  it('prefers longest overlapping key', async () => {
    const transform = replace({ a: 'X', ab: 'Y' });
    expect(await collect(transform(streamText('ab', 100)))).toBe('Y');
  });

  it('retains the source split-overlap fallback policy', async () => {
    const transform = replace({ a: 'X', ab: 'Y' });
    expect(await collectChunks(transform(streamChunks(['a', 'b'])))).toEqual(['X', 'b']);
  });

  it('does not cascade', async () => {
    const transform = replace({ a: 'b', b: 'c' });
    expect(await collect(transform(streamText('a', 100)))).toBe('b');
  });

  it('does not cascade replacement output across source chunks', async () => {
    const transform = replace({ a: 'b', bc: 'X' });
    expect(await collectChunks(transform(streamChunks(['a', 'c'])))).toEqual(['b', 'c']);
  });

  it('replaces Unicode regex case equivalents', async () => {
    const transform = replace({ S: 'ess', Σ: 'sigma' });
    expect(await collectChunks(transform(streamChunks(['Aſ', 'BςC'])))).toEqual([
      'Aess',
      'BsigmaC',
    ]);
  });

  it('uses source order for case-equivalent keys of equal length', async () => {
    const transform = replace({ S: 'first', s: 'second' });
    expect(await collect(transform(streamChunks(['s'])))).toBe('first');
  });

  it('handles UTF-16 splits without normalizing combining marks', async () => {
    const transform = replace({ '😀x': 'smile', é: 'e' });
    expect(
      await collectChunks(transform(streamChunks(['go \ud83d', '\ude00x; ', 'e\u0301']))),
    ).toEqual(['go ', 'smile; ', 'e\u0301']);
  });

  it('propagates source errors without flushing an unresolved prefix', async () => {
    const sourceError = new Error('source failed');
    let sourceController: ReadableStreamDefaultController<string> | undefined;
    const source = new ReadableStream<string>({
      start(controller) {
        sourceController = controller;
      },
    });
    const reader = replace({ LiveKit: 'Lyve Kit' })(source).getReader();
    if (!sourceController) throw new Error('source controller was not initialized');

    sourceController.enqueue('already emitted ');
    expect(await reader.read()).toEqual({ done: false, value: 'already emitted ' });
    sourceController.enqueue('Live');
    await new Promise<void>((resolve) => setImmediate(resolve));
    sourceController.error(sourceError);

    await expect(reader.read()).rejects.toBe(sourceError);
    reader.releaseLock();
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
