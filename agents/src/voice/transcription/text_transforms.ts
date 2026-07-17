// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { readStream } from '../../utils.js';

export type BuiltinTextTransform = 'filter_markdown' | 'filter_emoji';
export type TextTransform =
  | BuiltinTextTransform
  | ((text: ReadableStream<string>) => ReadableStream<string>);

const linePatterns: Array<[RegExp, string]> = [
  [/^#{1,6}\s+/gm, ''],
  [/^\s*[-+*]\s+/gm, ''],
  [/^\s*>\s+/gm, ''],
];

const inlinePatterns: Array<[RegExp, string]> = [
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/(?<![\w*])\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*(?![\w*])/g, '$1'],
  [/(?<![\w*])\*(?!\s|\*)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1'],
  [/(?<!\w)__([^_]+?)__(?!\w)/g, '$1'],
  [/(?<!\w)_([^_]+?)_(?!\w)/g, '$1'],
  [/`{3,4}[\S]*/g, ''],
  [/`([^`]+?)`/g, '$1'],
  [/~~(?!\s)([^~]*?)(?<!\s)~~/g, ''],
];

const inlineSplitTokens = ' ,.?!;，。？！；';
const completeLinksPattern = /\[[^\]]*\]\([^)]*\)/g;
const completeImagesPattern = /!\[[^\]]*\]\([^)]*\)/g;
const emojiPattern =
  /[\u{1f000}-\u{1fbff}]|[\u{2600}-\u{26ff}]|[\u{2700}-\u{27bf}]|[\u{2b00}-\u{2bff}]|[\u{fe00}-\u{fe0f}]|\u{200d}|\u{20e3}+/gu;

function streamFromAsyncIterable<T>(iterable: AsyncIterable<T>): ReadableStream<T> {
  return new ReadableStream<T>({
    async start(controller) {
      try {
        for await (const chunk of iterable) {
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

function hasIncompletePattern(buffer: string): boolean {
  if (['#', '-', '+', '*', '>', '!', '`', '~', ' '].some((token) => buffer.endsWith(token))) {
    return true;
  }

  const doubleAsterisks = countMatches(buffer, /\*\*/g);
  if (doubleAsterisks % 2 === 1) return true;

  const singleAsterisks = countMatches(buffer, /\*/g) - doubleAsterisks * 2;
  if (singleAsterisks % 2 === 1) return true;

  const doubleUnderscores = countMatches(buffer, /__/g);
  if (doubleUnderscores % 2 === 1) return true;

  const singleUnderscores = countMatches(buffer, /_/g) - doubleUnderscores * 2;
  if (singleUnderscores % 2 === 1) return true;

  const backticks = countMatches(buffer, /`/g);
  if (backticks % 2 === 1) return true;

  const doubleTildes = countMatches(buffer, /~~/g);
  if (doubleTildes % 2 === 1) return true;

  const openBrackets = countMatches(buffer, /\[/g);
  const completeLinks = countMatches(buffer, completeLinksPattern);
  const completeImages = countMatches(buffer, completeImagesPattern);

  return openBrackets - completeLinks - completeImages > 0;
}

function processCompleteText(text: string, isNewline = false): string {
  if (isNewline) {
    for (const [pattern, replacement] of linePatterns) {
      text = text.replace(pattern, replacement);
    }
  }

  for (const [pattern, replacement] of inlinePatterns) {
    text = text.replace(pattern, replacement);
  }

  return text;
}

export function filterMarkdown(text: ReadableStream<string>): ReadableStream<string> {
  return streamFromAsyncIterable(
    (async function* () {
      let buffer = '';
      let bufferIsNewline = true;

      for await (const chunk of readStream(text)) {
        buffer += chunk;

        if (buffer.includes('\n')) {
          const lines = buffer.split('\n');
          buffer = lines[lines.length - 1] ?? '';

          for (const [index, line] of lines.slice(0, -1).entries()) {
            const isNewline = index === 0 ? bufferIsNewline : true;
            yield `${processCompleteText(line, isNewline)}\n`;
          }

          bufferIsNewline = true;
          continue;
        }

        let lastSplitPos = 0;
        for (const token of inlineSplitTokens) {
          lastSplitPos = Math.max(lastSplitPos, buffer.lastIndexOf(token));
          if (lastSplitPos >= buffer.length - 1) break;
        }

        if (lastSplitPos >= 1) {
          const processable = buffer.slice(0, lastSplitPos);
          const rest = buffer.slice(lastSplitPos);
          if (!hasIncompletePattern(processable)) {
            yield processCompleteText(processable, bufferIsNewline);
            buffer = rest;
            bufferIsNewline = false;
          }
        }
      }

      if (buffer) {
        yield processCompleteText(buffer, bufferIsNewline);
      }
    })(),
  );
}

export function filterEmoji(text: ReadableStream<string>): ReadableStream<string> {
  return streamFromAsyncIterable(
    (async function* () {
      for await (const chunk of readStream(text)) {
        yield chunk.replace(emojiPattern, '');
      }
    })(),
  );
}

const builtinTransforms: Record<
  BuiltinTextTransform,
  (text: ReadableStream<string>) => ReadableStream<string>
> = {
  filter_markdown: filterMarkdown,
  filter_emoji: filterEmoji,
};

export function applyTextTransforms(
  text: ReadableStream<string>,
  transforms: readonly TextTransform[],
): ReadableStream<string> {
  for (const transform of transforms) {
    if (typeof transform === 'string') {
      const builtin = builtinTransforms[transform as BuiltinTextTransform];
      if (!builtin) {
        throw new Error(
          `Invalid transform: ${transform}, available transforms: ${Object.keys(builtinTransforms).join(', ')}`,
        );
      }
      text = builtin(text);
    } else if (typeof transform === 'function') {
      text = transform(text);
    } else {
      throw new Error(`Invalid transform: ${String(transform)}, must be a string or callable`);
    }
  }
  return text;
}

export const _applyTextTransforms = applyTextTransforms;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replace(
  replacements: Record<string, string>,
  options: { caseSensitive?: boolean } = {},
): (text: ReadableStream<string>) => ReadableStream<string> {
  const entries = Object.entries(replacements);
  const flags = options.caseSensitive ? 'u' : 'iu';
  const lookup = new Map(
    entries.map(([old, replacement]) => [
      options.caseSensitive ? old : old.toLowerCase(),
      replacement,
    ]),
  );
  const pattern =
    entries.length > 0
      ? new RegExp(
          entries
            .map(([old]) => old)
            .sort((a, b) => b.length - a.length)
            .map(escapeRegex)
            .join('|'),
          `g${flags}`,
        )
      : null;
  const maxPrefix = entries.length > 0 ? Math.max(...entries.map(([old]) => old.length - 1)) : 0;
  const prefixes = new Set<string>();
  for (const [old] of entries) {
    for (let length = 1; length < old.length; length += 1) {
      prefixes.add(old.slice(0, length));
    }
  }
  const holdbackPattern =
    prefixes.size > 0
      ? new RegExp(`(?:${Array.from(prefixes).map(escapeRegex).join('|')})$`, flags)
      : null;

  const apply = (value: string): string => {
    if (!pattern) return value;
    return value.replace(
      pattern,
      (match) => lookup.get(options.caseSensitive ? match : match.toLowerCase())!,
    );
  };

  const holdback = (value: string): number => {
    if (!holdbackPattern) return 0;
    const match = holdbackPattern.exec(value.slice(-maxPrefix));
    return match ? match[0].length : 0;
  };

  return (text: ReadableStream<string>) =>
    streamFromAsyncIterable(
      (async function* () {
        let buffer = '';

        for await (const chunk of readStream(text)) {
          buffer = apply(buffer + chunk);
          const flushTo = buffer.length - holdback(buffer);
          if (flushTo > 0) {
            yield buffer.slice(0, flushTo);
            buffer = buffer.slice(flushTo);
          }
        }

        if (buffer) {
          yield buffer;
        }
      })(),
    );
}
