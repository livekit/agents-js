// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { SentenceTokenizer } from './blingfire.js';

// Fixtures and expected output mirror tests/test_tokenizer.py in the python agents repo;
// both run the same livekit-blingfire core, so they must stay in sync.
const TEXT =
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

const EXPECTED_MIN_20 = [
  'Hi! LiveKit is a platform for live audio and video applications and services.',
  'R.T.C stands for Real-Time Communication... again R.T.C. Mr. Theo is testing the sentence tokenizer.',
  'This is a test. Another test.',
  'A short sentence. A longer sentence that is longer than the previous sentence. f(x) = x * 2.54 + 42.',
  'Hey! Hi! Hello! This is a sentence.',
  '这是一个中文句子。これは日本語の文章です。',
  '你好！LiveKit是一个直播音频和视频应用程序和服务的平台。',
  'This is a sentence contains   consecutive spaces.',
];

const MULTILINGUAL_SENT_CASES: [string, string[]][] = [
  // Arabic question mark
  [
    'هل تريد حجز موعد غداً؟ لدينا مواعيد متاحة في الصباح.',
    ['هل تريد حجز موعد غداً؟', 'لدينا مواعيد متاحة في الصباح.'],
  ],
  // Urdu full stop
  ['آپ کیسے ہیں۔ میں ٹھیک ہوں۔', ['آپ کیسے ہیں۔', 'میں ٹھیک ہوں۔']],
  // Devanagari danda (Hindi)
  ['आप कैसे हैं। मैं ठीक हूँ। धन्यवाद', ['आप कैसे हैं।', 'मैं ठीक हूँ।', 'धन्यवाद']],
  // Devanagari double danda
  ['श्लोक एक॥ श्लोक दो॥', ['श्लोक एक॥', 'श्लोक दो॥']],
  // Bengali also uses the danda
  ['আপনি কেমন আছেন। আমি ভালো আছি।', ['আপনি কেমন আছেন।', 'আমি ভালো আছি।']],
  // the closing quote stays with the sentence it ends
  ['वह बोली “मैं ठीक हूँ।” अगला वाक्य।', ['वह बोली “मैं ठीक हूँ।”', 'अगला वाक्य।']],
];

// push the text in chunks of arbitrary length (1-4)
function chunked(text: string): string[] {
  const pattern = [1, 2, 4];
  const chunks: string[] = [];
  for (let i = 0; text; i++) {
    const size = pattern[i % pattern.length]!;
    chunks.push(text.slice(0, size));
    text = text.slice(size);
  }
  return chunks;
}

describe('blingfire.SentenceTokenizer', () => {
  it('tokenizes sentences', () => {
    expect(new SentenceTokenizer({ minSentenceLength: 20 }).tokenize(TEXT)).toStrictEqual(
      EXPECTED_MIN_20,
    );
  });

  it('stream tokenizes sentences', async () => {
    const stream = new SentenceTokenizer({ minSentenceLength: 20 }).stream();
    for (const chunk of chunked(TEXT)) stream.pushText(chunk);
    stream.endInput();

    const tokens: string[] = [];
    for await (const ev of stream) tokens.push(ev.token);
    expect(tokens).toStrictEqual(EXPECTED_MIN_20);
  });

  it.each(MULTILINGUAL_SENT_CASES)('splits on non-latin terminators: %s', (text, expected) => {
    expect(new SentenceTokenizer({ minSentenceLength: 1 }).tokenize(text)).toStrictEqual(expected);
  });

  it('emits a hindi sentence before end of input', async () => {
    // the first sentence must reach TTS while the LLM is still generating
    const stream = new SentenceTokenizer().stream();
    for (const word of 'आप कैसे हैं, आज का दिन कैसा रहा। मैं ठीक हूँ, धन्यवाद आपका'.split(' ')) {
      stream.pushText(word + ' ');
    }

    const { value } = await stream.next();
    expect(value!.token).toBe('आप कैसे हैं, आज का दिन कैसा रहा।');
    stream.close();
  });

  it('retainFormat tokens slice back to the source text', () => {
    // offsets are UTF-16 code units, so astral characters (surrogate pairs) must not shift
    // the spans; joining the retained tokens must give back the input exactly
    const text = 'I love 🎉🎉 parties.\nNext sentence here. 𝒳 marks the spot. Bye';
    const tokens = new SentenceTokenizer({ minSentenceLength: 1, retainFormat: true }).tokenize(
      text,
    );
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join('')).toBe(text);
  });

  it('returns nothing for blank text', () => {
    expect(new SentenceTokenizer().tokenize('')).toStrictEqual([]);
    expect(new SentenceTokenizer().tokenize(' \n ')).toStrictEqual([]);
  });
});
