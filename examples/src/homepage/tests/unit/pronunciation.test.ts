// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  LIVEKITS_PRONUNCIATION,
  LIVEKIT_PRONUNCIATION,
  pronounceLiveKit,
} from '../../filters/pronunciation.js';

async function speak(...chunks: string[]): Promise<string> {
  const input = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  let result = '';
  for await (const piece of pronounceLiveKit(input)) result += piece;
  return result;
}

describe('pronounceLiveKit', () => {
  it('rewrites whole LiveKit words across arbitrary chunks', async () => {
    await expect(speak('I love LiveKit.')).resolves.toBe(`I love ${LIVEKIT_PRONUNCIATION}.`);
    await expect(speak('livekit is great')).resolves.toBe(`${LIVEKIT_PRONUNCIATION} is great`);
    await expect(speak('Live', 'Kit rocks')).resolves.toBe(`${LIVEKIT_PRONUNCIATION} rocks`);
    await expect(speak("LiveKit's SDK")).resolves.toBe(`${LIVEKITS_PRONUNCIATION} SDK`);
    await expect(speak('LiveKit’s SDK')).resolves.toBe(`${LIVEKITS_PRONUNCIATION} SDK`);
    await expect(speak('LiveKitten is not a product')).resolves.toBe('LiveKitten is not a product');
  });
});
