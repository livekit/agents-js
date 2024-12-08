// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { SentenceTokenizer, WordTokenizer, hyphenateWord } from './basic/index.js';
import { splitParagraphs } from './basic/paragraph.js';

const TEXT =
  'Hi! ' +
  'LiveKit is a platform for live audio and video applications and services. ' +
  'R.T.C stands for Real-Time Communication... again R.T.C. ' +
  'Mr. Theo is testing the sentence tokenizer. ' +
  'This is a test. Another test. ' +
  'A short sentence. ' +
  'A longer sentence that is longer than the previous sentence. ' +
  'f(x) = x * 2.54 + 42. ' +
  'Hey! Hi! Hello! ';

const EXPECTED_MIN_20 = [
  'Hi! LiveKit is a platform for live audio and video applications and services.',
  'R.T.C stands for Real-Time Communication... again R.T.C.',
  'Mr. Theo is testing the sentence tokenizer.',
  'This is a test. Another test.',
  'A short sentence. A longer sentence that is longer than the previous sentence.',
  'f(x) = x * 2.54 + 42.',
  'Hey! Hi! Hello!',
];

const WORDS_TEXT = 'This is a test. Blabla another test! multiple consecutive spaces:     done';
const WORDS_EXPECTED = [
  'This',
  'is',
  'a',
  'test',
  'Blabla',
  'another',
  'test',
  'multiple',
  'consecutive',
  'spaces',
  'done',
];

const WORDS_PUNCT_TEXT =
  'This is <phoneme alphabet="cmu-arpabet" ph="AE K CH UW AH L IY">actually</phoneme> tricky to handle.';
const WORDS_PUNCT_EXPECTED = [
  'This',
  'is',
  '<phoneme',
  'alphabet="cmu-arpabet"',
  'ph="AE',
  'K',
  'CH',
  'UW',
  'AH',
  'L',
  'IY">actually</phoneme>',
  'tricky',
  'to',
  'handle.',
];

const HYPHENATOR_TEXT = ['Segment', 'expected', 'communication', 'window', 'welcome', 'bedroom'];
const HYPHENATOR_EXPECTED = [
  ['Seg', 'ment'],
  ['ex', 'pect', 'ed'],
  ['com', 'mu', 'ni', 'ca', 'tion'],
  ['win', 'dow'],
  ['wel', 'come'],
  ['bed', 'room'],
];

const PARAGRAPH_TEST_CASES: [string, [string, number, number][]][] = [
  ['Single paragraph.', [['Single paragraph.', 0, 17]]],
  [
    'Paragraph 1.\n\nParagraph 2.',
    [
      ['Paragraph 1.', 0, 12],
      ['Paragraph 2.', 14, 26],
    ],
  ],
  [
    'Para 1.\n\nPara 2.\n\nPara 3.',
    [
      ['Para 1.', 0, 7],
      ['Para 2.', 9, 16],
      ['Para 3.', 18, 25],
    ],
  ],
  ['\n\nParagraph with leading newlines.', [['Paragraph with leading newlines.', 2, 34]]],
  ['Paragraph with trailing newlines.\n\n', [['Paragraph with trailing newlines.', 0, 33]]],
  [
    '\n\n  Paragraph with leading and trailing spaces.  \n\n',
    [['Paragraph with leading and trailing spaces.', 4, 47]],
  ],
  [
    'Para 1.\n\n\n\nPara 2.', // Multiple newlines between paragraphs
    [
      ['Para 1.', 0, 7],
      ['Para 2.', 11, 18],
    ],
  ],
  [
    'Para 1.\n \n \nPara 2.', // Newlines with spaces between paragraphs
    [
      ['Para 1.', 0, 7],
      ['Para 2.', 12, 19],
    ],
  ],
  [
    '', // Empty string
    [],
  ],
  [
    '\n\n\n', // Only newlines
    [],
  ],
  [
    'Line 1\nLine 2\nLine 3', // Single paragraph with newlines
    [['Line 1\nLine 2\nLine 3', 0, 20]],
  ],
];

describe('tokenizer', () => {
  describe('SentenceTokenizer', () => {
    const tokenizer = new SentenceTokenizer();

    it('should tokenize sentences correctly', () => {
      expect(tokenizer.tokenize(TEXT).every((x, i) => EXPECTED_MIN_20[i] === x)).toBeTruthy();
    });

    it('should stream tokenize sentences correctly', async () => {
      const pattern = [1, 2, 4];
      let text = TEXT;
      const chunks = [];
      const patternIter = Array(Math.ceil(text.length / pattern.reduce((sum, num) => sum + num, 0)))
        .fill(pattern)
        .flat()
        [Symbol.iterator]();

      for (const size of patternIter) {
        if (!text) break;
        chunks.push(text.slice(undefined, size));
        text = text.slice(size);
      }
      const stream = tokenizer.stream();
      for (const chunk of chunks) {
        stream.pushText(chunk);
      }
      stream.endInput();
      stream.close();

      for (const x of EXPECTED_MIN_20) {
        await stream.next().then((value) => {
          if (value.value) {
            expect(value.value.token).toStrictEqual(x);
          }
        });
      }
    });
  });
  describe('WordTokenizer', () => {
    const tokenizer = new WordTokenizer();

    it('should tokenize words correctly', () => {
      expect(tokenizer.tokenize(WORDS_TEXT).every((x, i) => WORDS_EXPECTED[i] === x)).toBeTruthy();
    });

    it('should stream tokenize words correctly', async () => {
      const pattern = [1, 2, 4];
      let text = WORDS_TEXT;
      const chunks = [];
      const patternIter = Array(Math.ceil(text.length / pattern.reduce((sum, num) => sum + num, 0)))
        .fill(pattern)
        .flat()
        [Symbol.iterator]();

      for (const size of patternIter) {
        if (!text) break;
        chunks.push(text.slice(undefined, size));
        text = text.slice(size);
      }
      const stream = tokenizer.stream();
      for (const chunk of chunks) {
        stream.pushText(chunk);
      }
      stream.endInput();
      stream.close();

      for (const x of WORDS_EXPECTED) {
        await stream.next().then((value) => {
          if (value.value) {
            expect(value.value.token).toStrictEqual(x);
          }
        });
      }
    });

    describe('punctuation handling', () => {
      const tokenizerPunct = new WordTokenizer(false);

      it('should tokenize words correctly', () => {
        expect(
          tokenizerPunct.tokenize(WORDS_PUNCT_TEXT).every((x, i) => WORDS_PUNCT_EXPECTED[i] === x),
        ).toBeTruthy();
      });

      it('should stream tokenize words correctly', async () => {
        const pattern = [1, 2, 4];
        let text = WORDS_PUNCT_TEXT;
        const chunks = [];
        const patternIter = Array(
          Math.ceil(text.length / pattern.reduce((sum, num) => sum + num, 0)),
        )
          .fill(pattern)
          .flat()
          [Symbol.iterator]();

        for (const size of patternIter) {
          if (!text) break;
          chunks.push(text.slice(undefined, size));
          text = text.slice(size);
        }
        const stream = tokenizerPunct.stream();
        for (const chunk of chunks) {
          stream.pushText(chunk);
        }
        stream.endInput();
        stream.close();

        for (const x of WORDS_PUNCT_EXPECTED) {
          await stream.next().then((value) => {
            if (value.value) {
              expect(value.value.token).toStrictEqual(x);
            }
          });
        }
      });
    });
  });
  describe('hyphenateWord', () => {
    it('should hyphenate correctly', () => {
      HYPHENATOR_TEXT.forEach((x, i) => {
        expect(hyphenateWord(x)).toStrictEqual(HYPHENATOR_EXPECTED[i]);
      });
    });
  });
  describe('splitParagraphs', () => {
    it('should tokenize paragraphs correctly', () => {
      PARAGRAPH_TEST_CASES.forEach(([a, b]) => {
        expect(splitParagraphs(a)).toStrictEqual(b);
      });
    });
  });
});
