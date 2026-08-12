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

const fullLinePatterns: Array<[RegExp, string]> = [
  [/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, ''],
];

// These scripts can put emphasis delimiters flush against a word character.
const flushEmphasisScripts = String.raw`\u0e00-\u0e7f\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9d`;
const unicodeWord = String.raw`[\p{L}\p{N}_]`;
const intraword = String.raw`(?:(?![${flushEmphasisScripts}])${unicodeWord})`;
const asteriskEmphasis = new RegExp(
  String.raw`(?<!${intraword})(?<!\*)(\*{1,3})(?!\s)([^*\n]+?)(?<!\s)\1(?!${intraword})(?!\*)`,
  'gu',
);
const underscoreEmphasis = new RegExp(
  String.raw`(?<!${unicodeWord})(_{1,3})(?!\s)([^_\n]+?)(?<!\s)\1(?!${unicodeWord})`,
  'gu',
);

const inlinePatterns: Array<[RegExp, string]> = [
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [asteriskEmphasis, '$2'],
  [underscoreEmphasis, '$2'],
  // nesting is order-dependent, so the asterisks get a second look once the underscores are gone
  [asteriskEmphasis, '$2'],
  [/`{3,4}[\S]*/g, ''],
  [/`([^`]+?)`/g, '$1'],
  [/~~(?!\s)[^~]*?(?<!\s)~~/g, ''],
];

const inlineSplitTokens = ' ,.?!;，。？！；';
const inlineMarkers = /[*_`~\[]/;
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

function countOccurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

// Delimiters are literals, so counting by split keeps callers free of regex escaping
// and compiles no pattern per buffer on the streaming path.
function unbalanced(buffer: string, delimiter: string): boolean {
  const doubles = countOccurrences(buffer, delimiter.repeat(2));
  if (doubles % 2 === 1) return true;
  return (countOccurrences(buffer, delimiter) - doubles * 2) % 2 === 1;
}

function hasIncompletePattern(buffer: string): boolean {
  if (['#', '-', '+', '*', '_', '>', '!', '`', '~', ' '].some((token) => buffer.endsWith(token))) {
    return true;
  }

  if (unbalanced(buffer, '*') || unbalanced(buffer, '_')) return true;

  // incomplete code (`text`) or strikethrough (~~text~~)
  if (countOccurrences(buffer, '`') % 2 === 1 || countOccurrences(buffer, '~~') % 2 === 1) {
    return true;
  }

  const openBrackets = countMatches(buffer, /\[/g);
  const completeLinks = countMatches(buffer, completeLinksPattern);
  const completeImages = countMatches(buffer, completeImagesPattern);

  return openBrackets - completeLinks - completeImages > 0;
}

function processCompleteText(text: string, isNewline: boolean, isLineEnd: boolean): string {
  if (isNewline) {
    if (isLineEnd) {
      for (const [pattern, replacement] of fullLinePatterns) {
        text = text.replace(pattern, replacement);
      }
    }

    for (const [pattern, replacement] of linePatterns) {
      text = text.replace(pattern, replacement);
    }
  }

  if (!inlineMarkers.test(text)) return text;

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
            yield `${processCompleteText(line, isNewline, true)}\n`;
          }

          bufferIsNewline = true;
          continue;
        }

        const lastSplitPos = Math.max(
          ...Array.from(inlineSplitTokens, (token) => buffer.lastIndexOf(token)),
        );

        if (lastSplitPos >= 1) {
          const processable = buffer.slice(0, lastSplitPos);
          const rest = buffer.slice(lastSplitPos);
          if (!hasIncompletePattern(processable)) {
            yield processCompleteText(processable, bufferIsNewline, false);
            buffer = rest;
            bufferIsNewline = false;
          }
        }
      }

      if (buffer) {
        yield processCompleteText(buffer, bufferIsNewline, true);
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
  const sortedEntries = [...entries].sort(([a], [b]) => b.length - a.length);
  const flags = options.caseSensitive ? 'u' : 'iu';
  const entryPatterns = sortedEntries.map(
    ([old, replacement]) => [new RegExp(`^(?:${escapeRegex(old)})$`, flags), replacement] as const,
  );
  const pattern =
    entries.length > 0
      ? new RegExp(sortedEntries.map(([old]) => escapeRegex(old)).join('|'), `g${flags}`)
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

  const apply = (value: string): { output: string; lastMatchEnd: number } => {
    if (!pattern) return { output: value, lastMatchEnd: 0 };
    let lastMatchEnd = 0;
    const output = value.replace(pattern, (match: string, offset: number) => {
      const entry = entryPatterns.find(([entryPattern]) => entryPattern.test(match));
      if (!entry) {
        throw new Error(`Unable to resolve replacement for matched text: ${match}`);
      }
      const replacement = entry[1];
      lastMatchEnd = offset + match.length;
      return replacement;
    });
    return { output, lastMatchEnd };
  };

  const holdback = (value: string): number => {
    if (!holdbackPattern) return 0;
    const match = holdbackPattern.exec(value.slice(-maxPrefix));
    return match ? match[0].length : 0;
  };

  return (text: ReadableStream<string>) =>
    streamFromAsyncIterable(
      (async function* () {
        let sourceBuffer = '';

        for await (const chunk of readStream(text)) {
          const source = sourceBuffer + chunk;
          const applied = apply(source);
          const heldLength = holdback(source);
          const heldStart = source.length - heldLength;
          const retainSource = heldLength > 0 && heldStart >= applied.lastMatchEnd;
          sourceBuffer = retainSource ? source.slice(heldStart) : '';
          const emitted = retainSource ? applied.output.slice(0, -heldLength) : applied.output;
          if (emitted) {
            yield emitted;
          }
        }

        if (sourceBuffer) {
          yield sourceBuffer;
        }
      })(),
    );
}
