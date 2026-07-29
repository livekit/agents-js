// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { LIVEKIT_IPA, pronounceLiveKit } from './filters/pronunciation.js';

async function speak(...chunks: string[]): Promise<string> {
  async function* gen() {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  const pieces: string[] = [];
  for await (const piece of pronounceLiveKit(gen())) {
    pieces.push(piece);
  }
  return pieces.join('');
}

describe('homepage pronunciation filter', () => {
  it('pronounces LiveKit as IPA for Inworld TTS', async () => {
    await expect(speak('I love LiveKit.')).resolves.toBe(`I love ${LIVEKIT_IPA}.`);
    await expect(speak('livekit is great')).resolves.toBe(`${LIVEKIT_IPA} is great`);
    await expect(speak('Live', 'Kit rocks')).resolves.toBe(`${LIVEKIT_IPA} rocks`);
    await expect(speak('LiveKitten is not a product')).resolves.toBe('LiveKitten is not a product');
  });
});
