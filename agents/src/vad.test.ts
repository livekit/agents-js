// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from './log.js';
import { VAD, VADStream } from './vad.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

class InputProbeStream extends VADStream {
  /** Reads what a VAD implementation would receive from its input. */
  async readInput(): Promise<(AudioFrame | 'flush')[]> {
    const received: (AudioFrame | 'flush')[] = [];
    while (true) {
      const { done, value } = await this.inputReader.read();
      if (done) return received;
      received.push(value === VADStream.FLUSH_SENTINEL ? 'flush' : value);
    }
  }
}

class ProbeVAD extends VAD {
  label = 'test.ProbeVAD';

  constructor() {
    super({ updateInterval: 100 });
  }

  stream(): InputProbeStream {
    return new InputProbeStream(this);
  }
}

function makeFrame(samples: number): AudioFrame {
  return new AudioFrame(new Int16Array(samples), 16000, 1, samples);
}

describe('VADStream.endInput', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);

  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    rejections.length = 0;
  });

  it('closes the input after buffered frames without an unhandled rejection', async () => {
    process.on('unhandledRejection', onRejection);
    const stream = new ProbeVAD().stream();
    const first = makeFrame(160);
    const second = makeFrame(320);

    stream.pushFrame(first);
    stream.flush();
    stream.pushFrame(second);
    stream.endInput();

    const received = await Promise.race([
      stream.readInput(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    // Let any discarded close() rejection surface before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toEqual([first, 'flush', second]);
    expect(rejections).toEqual([]);
    expect(() => stream.pushFrame(first)).toThrow('Input is closed');
    expect(() => stream.endInput()).toThrow('Input is closed');
    stream.close();
  });
});
