// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const EXPRESSION_RE = /<expression\s+value="([^"]*)"(?:\s*\/>|>(?:.*?)<\/expression>)/g;
const SOUND_RE = /<sound\s+value="([^"]*)"(?:\s*\/>|>(?:.*?)<\/sound>)/g;

/** Convert `<expression>` and `<sound>` XML tags to `[...]` bracket format. */
export function convertExpressionTags(text: string): string {
  return text
    .replace(EXPRESSION_RE, (_m, value: string) => `[${value}]`)
    .replace(SOUND_RE, (_m, value: string) => `[${value}]`);
}

const VALUE_ATTR_RE = /\b[\w-]+\s*=\s*"([^"]*)"/;

/**
 * Horizontal whitespace immediately before a tag. Every removal pattern captures it as
 * `pre` so {@link dedupRemovalSpace} can decide whether to keep it; newlines are excluded
 * so paragraph breaks are never touched.
 *
 * @internal
 */
export const LEADING_WS = '(?<pre>[^\\S\\r\\n]*)';

/**
 * Replacement text for a stripped tag, minus the space its removal would double.
 *
 * The instructions place an expression marker before *every* sentence, so a turn is
 * written with a marker delimited like a word — a space on each side — at every sentence
 * boundary:
 *
 * ```
 * <expr type="expression" label="sincere and concerned"/> Oh no, I'm sorry to hear
 * that. <expr type="expression" label="warm and grounded"/> I can certainly see what
 * we have available for you.
 * ```
 *
 * Both spaces are correct while the marker is there. Stripping it for the transcript
 * collapses its width to zero and leaves both behind, so every sentence lands with two
 * spaces after its punctuation (`"to hear that.  I can certainly"`) — every sentence of
 * every expressive turn, not an edge case.
 *
 * When nothing of the tag survives and whitespace follows the match, the whitespace
 * captured *before* it (the `pre` group) is therefore dropped so a single separator
 * remains — matching what `dropBracketCues` already does for bracket cues.
 *
 * Whitespace before a tag at the very end of *text* is kept: it may be the separator for
 * words still streaming in, and the sinks dedup that seam themselves.
 *
 * @param pre - The whitespace the pattern captured before the tag.
 * @param kept - The text that survives the removal (a wrapping tag's inner text or the
 *   native tag it lowers to), or `''` when the tag vanishes entirely.
 * @param source - The full string being replaced.
 * @param matchEnd - Index just past the end of the match in `source`.
 *
 * @internal
 */
export function dedupRemovalSpace(
  pre: string,
  kept: string,
  source: string,
  matchEnd: number,
): string {
  if (kept) return pre + kept;
  if (!pre) return '';
  const nxt = source.slice(matchEnd, matchEnd + 1);
  return nxt !== '' && /\s/.test(nxt) ? '' : pre;
}

/**
 * A replacer that receives the named groups, the match offset and the source string.
 *
 * `String.prototype.replace` passes `(match, ...groups, offset, string, groups?)`; the
 * groups object is only appended when the pattern has named groups, so the positional
 * arguments have to be read from the tail.
 *
 * @internal
 */
export function replaceWithGroups(
  text: string,
  pattern: RegExp,
  fn: (args: {
    match: string;
    groups: Record<string, string | undefined>;
    offset: number;
    source: string;
  }) => string,
): string {
  return text.replace(pattern, (...args: unknown[]): string => {
    const match = args[0] as string;
    const groups = (args[args.length - 1] ?? {}) as Record<string, string | undefined>;
    const source = args[args.length - 2] as string;
    const offset = args[args.length - 3] as number;
    return fn({ match, groups, offset, source });
  });
}

/**
 * What survives a removal, and the position to resume scanning from.
 *
 * A tag heading a line has no space before it to pair with, so the one after it is the
 * stranded half and goes with it. Anywhere else exactly one separator stays: the space
 * before is dropped when one already follows, kept when none does. Newlines are never
 * touched, so paragraph structure survives.
 *
 * @param emitted - The output assembled so far (a non-empty sentinel when the text does
 *   not begin a line).
 * @param text - The text being scanned.
 * @param pos - Index just past the end of the match in `text`.
 * @param pre - The whitespace the pattern captured before the tag.
 * @param kept - The text that survives the removal, or `''` when the tag vanishes.
 * @returns The text to append and the position to resume scanning from.
 *
 * @internal
 */
export function stripOne(
  emitted: string,
  text: string,
  pos: number,
  pre: string,
  kept: string,
): [append: string, pos: number] {
  if (kept) {
    return [pre + kept, pos];
  }
  if (!emitted || emitted.endsWith('\n')) {
    const rest = text.slice(pos);
    return ['', pos + rest.length - rest.replace(/^[ \t]+/, '').length];
  }
  const nxt = text[pos];
  return [pre && nxt !== ' ' && nxt !== '\t' ? pre : '', pos];
}

/**
 * Sentinel opening the output of a strip pass that does not begin a line, so
 * {@link stripOne} never mistakes the start of a mid-line chunk for a line start.
 *
 * @internal
 */
export const MID_LINE = '\u0000';

/** A markup tag stripped from text: the XML tag name and its payload. */
export type StrippedTag = [tag: string, value: string];

/**
 * Strip XML markup tags and collect the stripped tags in a single pass.
 *
 * One regex scan both removes the markup and records each removed tag, so stripping and
 * extraction can never disagree about what counts as a tag.
 *
 * Only XML-shaped markup is recognized. Square brackets are left alone: in LLM output
 * they are prose (`[text](url)` links) that a strip would mangle, and provider-native
 * ones are removed at their source by `dropBracketCues`.
 *
 * Returns `[cleanText, tags]` where `tags` is a list of `[type, value]` pairs in order of
 * appearance:
 *
 * - `type` is the XML tag name.
 * - `value` is a content tag's inner text (`<spell>A7X9</spell>` -> `"A7X9"`), else its
 *   first quoted attribute value (`<emotion value="happy"/>` -> `"happy"`), falling back
 *   to `""`. Names in `attributeTags` invert that preference — see the parameter.
 *
 * Wrapping tags keep their inner content in `cleanText` (only the delimiters are
 * removed); self-closing and lone tags are removed entirely.
 *
 * @param text - The text containing markup.
 * @param xmlTags - XML tag names to handle (e.g. `['emotion', 'sound']`).
 * @param attributeTags - Tag names whose payload is an attribute, never their content
 *   (`expression`, `emotion`, ...). These are self-closing by definition, but a model
 *   that writes `<expression value="warm">Hello there</expression>` would otherwise have
 *   the spoken sentence recorded as the delivery label and published as `lk.expression`.
 *   `normalizeMarkup` repairs that tag shape only on the audio path, so the transcript
 *   sinks see the raw form and have to handle it here.
 * @param options - `atLineStart`: whether `text` begins a line (default `true`); `false`
 *   for a chunk picked up mid-line, where leading whitespace is a real separator between
 *   two words.
 */
export function extractAndStrip(
  text: string,
  xmlTags: string[],
  attributeTags: ReadonlySet<string> = new Set(),
  options: { atLineStart?: boolean } = {},
): [string, StrippedTag[]] {
  const atLineStart = options.atLineStart ?? true;
  if (xmlTags.length === 0) {
    return [text, []];
  }

  const tagPattern = xmlTags.map(escapeRegExp).join('|');
  const pattern = new RegExp(
    // leading space is part of the match so removing a tag can't double the separator
    LEADING_WS +
      '(?:' +
      // self-closing `<tag .../>`, matched first and terminal: it has no span, so it must
      // never consume a following `</tag>` — that would swallow whatever sat between the
      // two and record it as this tag's value
      `<(?<selfTag>${tagPattern})\\b(?<selfAttrs>[^>]*?)\\s*/\\s*>` +
      // `<tag ...>` optionally followed by inner</tag>
      `|<(?<tag>${tagPattern})\\b(?<attrs>[^>]*?)\\s*>` +
      '(?:(?<inner>.*?)</\\k<tag>\\s*>)?' +
      // lone closing tag: </tag>
      `|</(?:${tagPattern})\\s*>` +
      ')',
    'gs',
  );

  const tags: StrippedTag[] = [];

  // the surviving text of one match: wrapping tags keep their inner content, self-closing
  // and lone tags vanish
  const kept = (groups: Record<string, string | undefined>): string => {
    if (groups.selfTag !== undefined) {
      const attrMatch = VALUE_ATTR_RE.exec(groups.selfAttrs ?? '');
      tags.push([groups.selfTag, attrMatch ? attrMatch[1]! : '']);
      return '';
    }

    const tag = groups.tag;
    if (tag !== undefined) {
      const inner = groups.inner;
      const attrMatch = VALUE_ATTR_RE.exec(groups.attrs ?? '');
      const attrValue = attrMatch ? attrMatch[1]! : '';
      // an attribute-carrying tag's payload is the attribute even when the model wrapped
      // text in it; everything else is a content tag, whose inner text wins
      let value: string;
      if (attributeTags.has(tag)) {
        value = attrValue || (inner?.trim() ?? '');
      } else if (inner !== undefined && inner.trim()) {
        value = inner.trim();
      } else {
        value = attrValue;
      }
      tags.push([tag, value]);
      return inner || '';
    }
    return ''; // lone closing tag
  };

  const pass = (source: string): string => {
    let out = atLineStart ? '' : MID_LINE;
    let pos = 0;
    for (const m of source.matchAll(pattern)) {
      const groups = m.groups ?? {};
      out += source.slice(pos, m.index);
      let append: string;
      [append, pos] = stripOne(out, source, m.index + m[0].length, groups.pre ?? '', kept(groups));
      out += append;
    }
    out += source.slice(pos);
    return atLineStart ? out : out.slice(MID_LINE.length);
  };

  // iterate to a fixed point so nested wrapping tags are fully removed: a single pass
  // strips only the outer tag (e.g. <excited><loud>hi</loud></excited> -> keeps the
  // inner <loud>hi</loud>), so repeat until the text stops changing. Each pass removes
  // at least the matched delimiters, so this always terminates.
  let clean = text;
  let prev: string | undefined;
  while (clean !== prev) {
    prev = clean;
    clean = pass(clean);
  }
  return [clean, tags];
}

/** @internal */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
