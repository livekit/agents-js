// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { type StreamChannel, createStreamChannel } from '../stream/stream_channel.js';
import { delay } from '../utils.js';
import { AgentInput, AudioInput } from './io.js';

class FakeAudioInput extends AudioInput {
  private chan: StreamChannel<AudioFrame> = createStreamChannel<AudioFrame>();

  constructor() {
    super();
    this.multiStream.addInputStream(this.chan.stream());
  }

  push(frame: AudioFrame): Promise<void> {
    return this.chan.write(frame);
  }
}

function makeFrame(sample: number): AudioFrame {
  return new AudioFrame(new Int16Array([sample]), 16000, 1, 1);
}

describe('AgentInput.setAudioEnabled', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
  });

  it('drops frames while detached and resumes after re-attach', async () => {
    const audio = new FakeAudioInput();
    const input = new AgentInput(() => {});
    input.audio = audio;

    const received: number[] = [];
    const reader = audio.stream.getReader();
    const pump = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received.push(value.data[0]!);
      }
    })();

    await audio.push(makeFrame(1));
    await delay(50);
    expect(received).toEqual([1]);

    input.setAudioEnabled(false);

    await audio.push(makeFrame(2));
    await delay(50);
    expect(received).toEqual([1]);

    input.setAudioEnabled(true);

    await audio.push(makeFrame(3));
    await delay(50);
    expect(received).toEqual([1, 3]);

    await audio.close();
    await pump;
  });
});
