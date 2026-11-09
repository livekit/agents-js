// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { isPunctuation } from '../tokenizer.js';

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
        .filter((character) => !isPunctuation(character))
        .join('');
    }

    if (word) {
      words.push([word, start, end]);
    }
  }

  return words;
};
