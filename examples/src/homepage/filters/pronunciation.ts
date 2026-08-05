// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Inworld custom pronunciation for the word "LiveKit". */
export const LIVEKIT_IPA = '/ˈlaɪvkɪt/';
const LIVEKIT_RE = /\blivekit\b/gi;

async function* wholeWords(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    while (buffer.includes(' ')) {
      const separator = buffer.indexOf(' ');
      yield `${buffer.slice(0, separator)} `;
      buffer = buffer.slice(separator + 1);
    }
  }
  if (buffer) yield buffer;
}

/** Rewrite only complete words while preserving arbitrary LLM chunk boundaries. */
export async function* pronounceLiveKit(text: AsyncIterable<string>): AsyncIterable<string> {
  for await (const word of wholeWords(text)) {
    yield word.replace(LIVEKIT_RE, LIVEKIT_IPA);
  }
}
