// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const LIVEKIT_IPA = '/ˈlaɪvkɪt/';

const LIVEKIT_RE = /\blivekit\b/gi;

async function* wholeWords(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    while (buffer.includes(' ')) {
      const idx = buffer.indexOf(' ');
      const word = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      yield `${word} `;
    }
  }
  if (buffer) {
    yield buffer;
  }
}

export async function* pronounceLiveKit(text: AsyncIterable<string>): AsyncIterable<string> {
  for await (const word of wholeWords(text)) {
    yield word.replace(LIVEKIT_RE, LIVEKIT_IPA);
  }
}
