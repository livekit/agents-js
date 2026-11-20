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

// A run that could still open emphasis; `5 * 3` or `a_b@x.com` never can.
const asteriskOpener = new RegExp(String.raw`(?<!${intraword})(?<!\*)\*{1,3}(?![\s*])`, 'u');
const underscoreOpener = /(?<![\p{L}\p{N}_])_{1,3}(?![\s_])/u;

// A link or image still being written; `[1]` followed by text is not one.
const pendingLink = /\[[^\]]*(?:\]|\]\([^)]*)?$/;
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

function countOccurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

function pendingEmphasis(buffer: string): boolean {
  for (const pattern of [asteriskEmphasis, underscoreEmphasis, asteriskEmphasis]) {
    buffer = buffer.replace(pattern, '$2');
  }
  return asteriskOpener.test(buffer) || underscoreOpener.test(buffer);
}

function hasIncompletePattern(buffer: string): boolean {
  if (['#', '-', '+', '*', '_', '>', '!', '`', '~', ' '].some((token) => buffer.endsWith(token))) {
    return true;
  }

  if (pendingEmphasis(buffer)) return true;

  // incomplete code (`text`) or strikethrough (~~text~~)
  if (countOccurrences(buffer, '`') % 2 === 1 || countOccurrences(buffer, '~~') % 2 === 1) {
    return true;
  }

  return pendingLink.test(buffer);
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

  const apply = (value: string): string => {
    if (!pattern) return value;
    return value.replace(pattern, (match: string) => {
      const entry = entryPatterns.find(([entryPattern]) => entryPattern.test(match));
      if (!entry) {
        throw new Error(`Unable to resolve replacement for matched text: ${match}`);
      }
      return entry[1];
    });
  };

  const holdback = (value: string): number => {
    if (!holdbackPattern) return 0;
    const match = holdbackPattern.exec(value.slice(-maxPrefix));
    return match ? match[0].length : 0;
  };

  // `value.slice(cut)` is held back because it may still grow into a longer key; a match
  // that straddles that boundary must be pulled into the flushed part, otherwise it would
  // be split and never matched.
  const flushIndex = (value: string): number => {
    let cut = value.length - holdback(value);
    if (!pattern) return cut;
    for (const match of value.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end <= cut) continue;
      if (match.index >= cut) break;
      cut = end;
    }
    return cut;
  };

  return (text: ReadableStream<string>) =>
    streamFromAsyncIterable(
      (async function* () {
        let sourceBuffer = '';

        for await (const chunk of readStream(text)) {
          const source = sourceBuffer + chunk;
          const cut = flushIndex(source);
          sourceBuffer = source.slice(cut);
          const emitted = apply(source.slice(0, cut));
          if (emitted) {
            yield emitted;
          }
        }

        const remaining = apply(sourceBuffer);
        if (remaining) {
          yield remaining;
        }
      })(),
    );
}
