// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { SentenceTokenizer, WordTokenizer, hyphenateWord } from './basic/index.js';
import { splitParagraphs } from './basic/paragraph.js';
import * as blingfire from './blingfire.js';

const TEXT =
  'Hi! ' +
  'LiveKit is a platform for live audio and video applications and services. ' +
  'R.T.C stands for Real-Time Communication... again R.T.C. ' +
  'Mr. Theo is testing the sentence tokenizer. ' +
  'This is a test. Another test. ' +
  'A short sentence. ' +
  'A longer sentence that is longer than the previous sentence. ' +
  'Find additional resources on livekit.com. ' +
  'Find additional resources on docs.livekit.com. ' +
  'f(x) = x * 2.54 + 42. ' +
  'Hey! Hi! Hello! ';

const EXPECTED_MIN_20 = [
  'Hi! LiveKit is a platform for live audio and video applications and services.',
  'R.T.C stands for Real-Time Communication... again R.T.C.',
  'Mr. Theo is testing the sentence tokenizer.',
  'This is a test. Another test.',
  'A short sentence. A longer sentence that is longer than the previous sentence.',
  'Find additional resources on livekit.com.',
  'Find additional resources on docs.livekit.com.',
  'f(x) = x * 2.54 + 42.',
  'Hey! Hi! Hello!',
];

// Mirrors tests/test_tokenizer.py in the python agents repo; the expected
// output must stay in sync with livekit-blingfire's.
const BLINGFIRE_TEXT =
  'Hi! ' +
  'LiveKit is a platform for live audio and video applications and services. \n\n' +
  'R.T.C stands for Real-Time Communication... again R.T.C. ' +
  'Mr. Theo is testing the sentence tokenizer. ' +
  '\nThis is a test. Another test. ' +
  'A short sentence.\n' +
  'A longer sentence that is longer than the previous sentence. ' +
  'f(x) = x * 2.54 + 42. ' +
  'Hey!\n Hi! Hello! ' +
  '\n\n' +
  'This is a sentence. 这是一个中文句子。これは日本語の文章です。' +
  '你好！LiveKit是一个直播音频和视频应用程序和服务的平台。' +
  '\nThis is a sentence contains   consecutive spaces.';

const BLINGFIRE_EXPECTED_MIN_20 = [
  'Hi! LiveKit is a platform for live audio and video applications and services.',
  'R.T.C stands for Real-Time Communication... again R.T.C. Mr. Theo is testing the sentence tokenizer.',
  'This is a test. Another test.',
  'A short sentence. A longer sentence that is longer than the previous sentence. f(x) = x * 2.54 + 42.',
  'Hey! Hi! Hello! This is a sentence.',
  '这是一个中文句子。これは日本語の文章です。',
  '你好！LiveKit是一个直播音频和视频应用程序和服务的平台。',
  'This is a sentence contains   consecutive spaces.',
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
  describe('blingfire.SentenceTokenizer', () => {
    const tokenizer = new blingfire.SentenceTokenizer();

    it('should tokenize sentences correctly', () => {
      const segmented = tokenizer.tokenize(BLINGFIRE_TEXT);
      BLINGFIRE_EXPECTED_MIN_20.forEach((x, i) => {
        expect(segmented[i]).toStrictEqual(x);
      });
    });

    it('should stream tokenize sentences correctly', async () => {
      const pattern = [1, 2, 4];
      let text = BLINGFIRE_TEXT;
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

      for (const x of BLINGFIRE_EXPECTED_MIN_20) {
        await stream.next().then((value) => {
          if (value.value) {
            expect(value.value.token).toStrictEqual(x);
          }
        });
      }
    });
  });
  describe('blingfire.WordTokenizer', () => {
    const tokenizer = new blingfire.WordTokenizer();

    it('should tokenize words correctly', () => {
      expect(tokenizer.tokenize(WORDS_TEXT).every((x, i) => WORDS_EXPECTED[i] === x)).toBeTruthy();
    });

    it('should keep punctuation attached to words when not ignored', () => {
      const words = blingfire.splitWords('Hello world! How are you?', false);
      expect(words.map((w) => w[0])).toStrictEqual(['Hello', 'world!', 'How', 'are', 'you?']);
      // spans must slice back to the source text
      words.forEach(([word, start, end]) => {
        expect('Hello world! How are you?'.slice(start, end)).toStrictEqual(word);
      });
    });
  });
});
