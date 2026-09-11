// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { PUNCTUATIONS } from '../tokenizer.js';

// Strip punctuation by set membership rather than a regex built from the joined
// list: concatenating the characters into a `[...]` class mis-parses the members
// that are regex-significant (e.g. `\` followed by `]` becomes an escaped `]`, so
// backslash was never stripped, and `,-.` silently forms a range).
const PUNCTUATION_SET = new Set(PUNCTUATIONS);

/**
 * Split the text into words.
 */
export const splitWords = (text: string, ignorePunctuation = true): [string, number, number][] => {
  const re = /\S+/g;
  const words: [string, number, number][] = [];

  let arr;
  while ((arr = re.exec(text)) !== null) {
    let word = arr[0];
    const start = arr.index;
    const end = start + word.length;

    if (ignorePunctuation) {
      word = Array.from(word)
        .filter((c) => !PUNCTUATION_SET.has(c))
        .join('');
    }

    words.push([word, start, end]);
  }

  return words;
};
