// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { isPunctuation } from '../tokenizer.js';

// kana, CJK ideographs and Thai: scripts written without spaces between words
const CHAR_BASED = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u0e00-\u0e7f]/;

/**
 * Split the text into words.
 *
 * Words are separated by whitespace. With `splitCharacter`, each kana, CJK ideograph and Thai
 * character is also its own word, since those scripts don't put spaces between words.
 */
export const splitWords = (
  text: string,
  ignorePunctuation = true,
  splitCharacter = false,
): [string, number, number][] => {
  const words: [string, number, number][] = [];

  const addWord = (start: number, end: number) => {
    let word = text.slice(start, end);
    if (ignorePunctuation) {
      word = Array.from(word)
        .filter((character) => !isPunctuation(character))
        .join('');
    }
    if (word) {
      words.push([word, start, end]);
    }
  };

  const re = /\S+/g;
  let arr;
  while ((arr = re.exec(text)) !== null) {
    const start = arr.index;
    const end = start + arr[0].length;

    if (!splitCharacter) {
      addWord(start, end);
      continue;
    }

    let wordStart = start;
    for (let pos = start; pos < end; pos++) {
      if (CHAR_BASED.test(text[pos]!)) {
        if (wordStart < pos) addWord(wordStart, pos);
        addWord(pos, pos + 1);
        wordStart = pos + 1;
      }
    }
    if (wordStart < end) addWord(wordStart, end);
  }

  return words;
};
