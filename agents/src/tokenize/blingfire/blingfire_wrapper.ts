import createModule from './blingfire.js';

const Module = (await createModule()) as any;

// breaks to sentences, takes a JS string and returns a JS string
export function TextToSentences(s: string): string | null {
  const len = Module['lengthBytesUTF8'](s);

  if (!len) {
    return null;
  }

  const inUtf8 = Module['_malloc'](len + 1); // if we don't do +1 this library won't copy the last character
  Module['stringToUTF8'](s, inUtf8, len + 1); //  since it always also needs a space for a 0-char

  const MaxOutLength = (len << 1) + 1; // worst case every character is a token
  const outUtf8 = Module['_malloc'](MaxOutLength);

  try {
    const actualLen = Module['_TextToSentences'](inUtf8, len, outUtf8, MaxOutLength);
    if (0 > actualLen || actualLen > MaxOutLength) {
      return null;
    }
  } finally {
    if (inUtf8 != 0) {
      Module['_free'](inUtf8);
    }

    if (outUtf8 != 0) {
      Module['_free'](outUtf8);
    }
  }

  return Module['UTF8ToString'](outUtf8);
}
