// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// A CR at the end of the text may be the first half of a CRLF split across chunks.
const LINE_END = /\r\n|\r(?!$)|\n/;

/**
 * Incremental Server-Sent Events decoder that returns the `data` of each complete event.
 *
 * Speechify names every event in its JSON payload, so the `event`, `id` and `retry` fields
 * are not needed and are skipped.
 * @internal
 */
export class SSEDecoder {
  #buffer = '';
  #data: string[] = [];

  push(text: string): string[] {
    const lines = (this.#buffer + text).split(LINE_END);
    this.#buffer = lines.pop()!;
    const events: string[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.#data.length > 0) events.push(this.#data.join('\n'));
        this.#data = [];
      } else if (line === 'data' || line.startsWith('data:')) {
        this.#data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    return events;
  }
}
