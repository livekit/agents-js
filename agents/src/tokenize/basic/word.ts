// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { isPunctuation } from '../tokenizer.js';

const CJK_CLAUSE_PUNCTUATION = new Set(['，', '。', '！', '？', '；', '：', '、']);
const CJK_TEXT =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/u;
const DIGIT = /\p{Nd}/u;

const splitWordsImpl = (
  text: string,
  ignorePunctuation = true,
  splitCjkClauses = false,
): [string, number, number][] => {
  const re = /\S+/g;
  const words: [string, number, number][] = [];

  let arr;
  while ((arr = re.exec(text)) !== null) {
    const rawWord = arr[0];
    const tokenStart = arr.index;
    let wordStart = 0;

    const addWord = (start: number, end: number) => {
      let word = rawWord.slice(start, end);

      if (ignorePunctuation) {
        word = Array.from(word)
          .filter((character) => !isPunctuation(character))
          .join('');
      }

      if (word) {
        words.push([word, tokenStart + start, tokenStart + end]);
      }
    };

    if (splitCjkClauses) {
      let previousCharacter = '';
      for (let pos = 0; pos < rawWord.length; ) {
        const character = String.fromCodePoint(rawWord.codePointAt(pos)!);
        const end = pos + character.length;

        if (
          CJK_CLAUSE_PUNCTUATION.has(character) &&
          CJK_TEXT.test(previousCharacter) &&
          !(['，', '：'].includes(character) && DIGIT.test(previousCharacter))
        ) {
          addWord(wordStart, end);
          wordStart = end;
        }

        previousCharacter = character;
        pos = end;
      }
    }

    addWord(wordStart, rawWord.length);
  }

  return words;
};

/**
 * Split the text into words.
 */
export const splitWords = (text: string, ignorePunctuation = true) =>
  splitWordsImpl(text, ignorePunctuation);

export const splitCjkWords = (text: string, ignorePunctuation = true) =>
  splitWordsImpl(text, ignorePunctuation, true);
