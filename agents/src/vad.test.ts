// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { VAD, VADStream } from './vad.js';

class IdleVADStream extends VADStream {}

class IdleVAD extends VAD {
  label = 'idle-vad';

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): VADStream {
    return new IdleVADStream(this);
  }
}

describe('VADStream.close', () => {
  it('releases an input stream that is still attached', () => {
    const stream = new IdleVAD().stream();
    const input = new ReadableStream<AudioFrame>();
    stream.updateInputStream(input);
    expect(input.locked).toBe(true);

    stream.close();

    expect(input.locked).toBe(false);
  });
});
