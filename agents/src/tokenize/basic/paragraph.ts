// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Split the text into paragraphs.
 */
export const splitParagraphs = (text: string): [string, number, number][] => {
  const re = /\n\s*\n/g;
  const splits = Array.from(text.matchAll(re));

  const paragraphs: [string, number, number][] = [];
  let start = 0;

  // no splits (single paragraph)
  if (splits.length === 0) {
    const stripped = text.trim();
    if (!stripped) return paragraphs;

    const start = text.indexOf(stripped);
    return [[stripped, start, start + stripped.length]];
  }

  for (const split of splits) {
    const end = split.index!;
    const paragraph = text.slice(start, end).trim();
    if (paragraph) {
      const paragraphStart = start + text.slice(start, end).indexOf(paragraph);
      const paragraphEnd = paragraphStart + paragraph.length;
      paragraphs.push([paragraph, paragraphStart, paragraphEnd]);
    }
    start = end + split[0].length;
  }

  const lastParagraph = text.slice(start).trim();
  if (lastParagraph) {
    const paragraphStart = start + text.slice(start).indexOf(lastParagraph);
    const paragraphEnd = paragraphStart + lastParagraph.length;
    paragraphs.push([lastParagraph, paragraphStart, paragraphEnd]);
  }

  return paragraphs;
};
