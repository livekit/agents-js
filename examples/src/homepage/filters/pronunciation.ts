// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';

export const LIVEKIT_PRONUNCIATION = 'Lyve Kit';
export const LIVEKITS_PRONUNCIATION = "Lyve Kit's";
const LIVEKIT_RE = /\blivekit(?<possessive>['’]s)?\b/gi;

function replaceLiveKit(match: string, possessive: string | undefined): string {
  return possessive ? LIVEKITS_PRONUNCIATION : LIVEKIT_PRONUNCIATION;
}

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
export function pronounceLiveKit(text: ReadableStream<string>): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const word of wholeWords(text)) {
          controller.enqueue(word.replace(LIVEKIT_RE, replaceLiveKit));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
