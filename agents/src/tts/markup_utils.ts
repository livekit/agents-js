// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const EXPRESSION_RE = /<expression\s+value="([^"]*)"(?:\s*\/>|>(?:.*?)<\/expression>)/gs;
const SOUND_RE = /<sound\s+value="([^"]*)"(?:\s*\/>|>(?:.*?)<\/sound>)/gs;

/** Convert `<expression>` and `<sound>` XML tags to `[...]` bracket format. */
export function convertExpressionTags(text: string): string {
  text = text.replace(EXPRESSION_RE, (_m, value: string) => `[${value}]`);
  text = text.replace(SOUND_RE, (_m, value: string) => `[${value}]`);
  return text;
}

const VALUE_ATTR_RE = /\b[\w-]+\s*=\s*"([^"]*)"/;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Strip markup and collect the stripped tags in a single pass.
 *
 * One regex scan both removes the markup and records each removed tag, so
 * stripping and extraction can never disagree about what counts as a tag.
 *
 * Returns `[cleanText, tags]` where `tags` is a list of `[type, value]`
 * pairs in order of appearance:
 *
 * - `type` is the XML tag name, or `""` for square-bracket tags.
 * - `value` is a wrapping tag's inner text (`<spell>A7X9</spell>` ->
 *   `"A7X9"`), else its first quoted attribute value
 *   (`<emotion value="happy"/>` -> `"happy"`), else the bracket content,
 *   falling back to `""`.
 *
 * Wrapping tags keep their inner content in `cleanText` (only the delimiters
 * are removed); self-closing, lone, and bracket tags are removed entirely.
 *
 * @param text - The text containing markup.
 * @param xmlTags - XML tag names to handle (e.g. `["emotion", "sound"]`).
 * @param brackets - Whether to also handle square-bracket tags like `[laughs]`.
 * @param offsetsOut - Optional array receiving, per recorded tag, the offset of its
 *   match so callers can merge tags from separate stripping passes in document order.
 *   Offsets are exact for top-level tags; a tag exposed by unwrapping an outer tag
 *   (nested markup, found in a later fixed-point pass) reports its offset within the
 *   partially-stripped text — approximate, but ordering stays monotonic in practice.
 */
export function extractAndStrip(
  text: string,
  options: { xmlTags: string[]; brackets: boolean; offsetsOut?: number[] },
): [string, Array<[string, string]>] {
  const { xmlTags, brackets, offsetsOut } = options;
  if (xmlTags.length === 0 && !brackets) {
    return [text, []];
  }

  const alternatives: string[] = [];
  if (xmlTags.length > 0) {
    const tagPattern = xmlTags.map(escapeRegExp).join('|');
    // <tag .../> or <tag ...> optionally followed by inner</tag>
    alternatives.push(
      `<(?<tag>${tagPattern})\\b(?<attrs>[^>]*?)\\s*\\/?\\s*>` +
        `(?:(?<inner>.*?)<\\/\\k<tag>\\s*>)?`,
    );
    // lone closing tag: </tag>
    alternatives.push(`<\\/(?:${tagPattern})\\s*>`);
  }
  if (brackets) {
    alternatives.push(String.raw`\[(?<bracket>[^\]]+)\]`);
  }

  const pattern = new RegExp(alternatives.join('|'), 'gs');
  const tags: Array<[string, string]> = [];

  const repl = (match: string, ...args: unknown[]): string => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    const offset = args[args.length - 3] as number;
    const tag = groups.tag;
    if (tag !== undefined) {
      const inner = groups.inner;
      let value: string;
      if (inner !== undefined && inner.trim()) {
        value = inner.trim();
      } else {
        const attrMatch = VALUE_ATTR_RE.exec(groups.attrs ?? '');
        value = attrMatch ? attrMatch[1]! : '';
      }
      tags.push([tag, value]);
      offsetsOut?.push(offset);
      // wrapping tags keep their inner content; self-closing/lone tags vanish
      return inner !== undefined ? inner : '';
    }

    const bracket = groups.bracket;
    if (bracket !== undefined) {
      tags.push(['', bracket.trim()]);
      offsetsOut?.push(offset);
      return '';
    }

    return ''; // lone closing tag
  };

  // iterate to a fixed point so nested wrapping tags are fully removed: a single pass
  // strips only the outer tag (e.g. <excited><loud>hi</loud></excited> -> keeps the
  // inner <loud>hi</loud>), so repeat until the text stops changing. Each pass removes
  // at least the matched delimiters, so this always terminates.
  let clean = text;
  let prev: string | undefined = undefined;
  while (clean !== prev) {
    prev = clean;
    clean = clean.replace(pattern, repl);
  }
  return [clean, tags];
}

/** Strip square bracket tags like `[laughs]`, `[whisper]` from text. */
export function stripBracketTags(text: string): string {
  return extractAndStrip(text, { xmlTags: [], brackets: true })[0];
}

/**
 * Strip specific XML-style tags from text, preserving their inner content.
 *
 * Handles opening/closing tag pairs (`<tag ...>content</tag>`) and
 * self-closing tags (`<tag .../>`, `<tag />`).
 *
 * @param text - The text containing XML-style markup.
 * @param tags - List of tag names to strip (e.g. `["emotion", "speed"]`).
 * @returns The text with the specified tags removed but their content preserved.
 */
export function stripXmlTags(text: string, tags: string[]): string {
  return extractAndStrip(text, { xmlTags: tags, brackets: false })[0];
}
