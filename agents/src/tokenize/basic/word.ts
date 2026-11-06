// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { isPunctuation } from '../tokenizer.js';

/**
 * Split the text into words.
 *
 * With `splitCharacter`, each Chinese, Japanese or Thai character is a word, since those
 * scripts are written without spaces.
 */
export const splitWords = (
  text: string,
  ignorePunctuation = true,
  splitCharacter = false,
): [string, number, number][] => {
  const re = splitCharacter
    ? /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u0e00-\u0e7f]|[^\s\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u0e00-\u0e7f]+/g
    : /\S+/g;
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
