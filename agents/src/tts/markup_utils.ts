// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const EXPRESSION_RE = /<expression\s+value="([^"]*)"(?:\s*\/|>(?:.*?)<\/expression)>/gs;
const SOUND_RE = /<sound\s+value="([^"]*)"(?:\s*\/|>(?:.*?)<\/sound)>/gs;
const VALUE_ATTR_RE = /\b[\w-]+\s*=\s*"([^"]*)"/;

export function convertExpressionTags(text: string): string {
  return text
    .replace(EXPRESSION_RE, (_match, value: string) => `[${value}]`)
    .replace(SOUND_RE, (_match, value: string) => `[${value}]`);
}

export function extractAndStrip(options: {
  text: string;
  xmlTags: readonly string[];
  brackets: boolean;
}): { clean: string; tags: Array<[string, string]> } {
  const { text, xmlTags, brackets } = options;
  if (xmlTags.length === 0 && !brackets) {
    return { clean: text, tags: [] };
  }

  const alternatives: string[] = [];
  if (xmlTags.length > 0) {
    const tagPattern = xmlTags.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    alternatives.push(
      `<(?<tag>${tagPattern})\\b(?<attrs>[^>]*?)\\s*\\/?\\s*>(?:(?<inner>.*?)<\\/\\k<tag>\\s*>)?`,
    );
    alternatives.push(`<\\/(?:${tagPattern})\\s*>`);
  }
  if (brackets) {
    alternatives.push('\\[(?<bracket>[^\\]]+)\\]');
  }

  const pattern = new RegExp(alternatives.join('|'), 'gs');
  const tags: Array<[string, string]> = [];
  let clean = text;
  let prev: string | undefined;

  while (clean !== prev) {
    prev = clean;
    clean = clean.replace(pattern, (...args: unknown[]) => {
      const groups = args[args.length - 1] as
        | { tag?: string; attrs?: string; inner?: string; bracket?: string }
        | undefined;
      if (!groups) return '';

      if (groups.tag !== undefined) {
        const inner = groups.inner;
        const attrMatch = VALUE_ATTR_RE.exec(groups.attrs ?? '');
        const value = inner?.trim() || attrMatch?.[1] || '';
        tags.push([groups.tag, value]);
        return inner ?? '';
      }

      if (groups.bracket !== undefined) {
        tags.push(['', groups.bracket.trim()]);
        return '';
      }

      return '';
    });
  }

  return { clean, tags };
}
