// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { SentenceStream, SentenceTokenizer, blingfire } from '../tokenize/index.js';
import type { TokenData } from '../tokenize/index.js';
import type { APIConnectOptions } from '../types.js';
import { delay, shortuuid } from '../utils.js';
import { SentenceStreamPacer, type StreamPacerWrapper } from './stream_pacer.js';
import { ChunkedStream, TTS } from './tts.js';
import type { SynthesizeStream } from './tts.js';

const SAMPLE_RATE = 24_000;
const REPLY =
  "I'm doing well, thanks! How are you? Today we'll practice minimal " +
  'pairs, words that differ by just one sound, like sheep and ship.';

const synthesized: string[] = [];
const pacers: StreamPacerWrapper[] = [];

class DelayedEndSentenceStream extends SentenceStream {
  constructor(private readonly wrapped: SentenceStream) {
    super();
  }

  override pushText(text: string): void {
    this.wrapped.pushText(text);
  }

  override flush(): void {
    this.wrapped.flush();
  }

  override endInput(): void {
    setImmediate(() => this.wrapped.endInput());
  }

  override close(): void {
    this.wrapped.close();
  }

  override next(): Promise<IteratorResult<TokenData>> {
    return this.wrapped.next();
  }
}

class DelayedEndSentenceTokenizer extends SentenceTokenizer {
  private readonly wrapped = new blingfire.SentenceTokenizer({ retainFormat: true });

  tokenize(text: string, language?: string): string[] {
    return this.wrapped.tokenize(text, language);
  }

  stream(): SentenceStream {
    return new DelayedEndSentenceStream(this.wrapped.stream());
  }
}

class FakeChunkedStream extends ChunkedStream {
  label = 'test.FakeChunkedStream';

  protected async run(): Promise<void> {
    synthesized.push(this.inputText);
    await delay(600);
    const duration = this.inputText.length * 0.08;
    let sent = 0;
    while (sent < duration) {
      const samples = SAMPLE_RATE * 0.1;
      this.queue.put({
        requestId: shortuuid(),
        segmentId: '',
        frame: new AudioFrame(new Int16Array(samples), SAMPLE_RATE, 1, samples),
        final: sent + 0.1 >= duration,
      });
      sent += 0.1;
      await delay(10);
    }
  }
}

class FakeTTS extends TTS {
  label = 'test.FakeTTS';

  constructor() {
    super(SAMPLE_RATE, 1, { streaming: false });
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new FakeChunkedStream(text, this, connOptions, abortSignal);
  }

  stream(): SynthesizeStream {
    throw new Error('not implemented');
  }
}

class RecordingPacer extends SentenceStreamPacer {
  override wrap(sentStream: SentenceStream, pushedAudioDuration: () => number): SentenceStream {
    const wrapper = super.wrap(sentStream, pushedAudioDuration);
    pacers.push(wrapper as StreamPacerWrapper);
    return wrapper;
  }
}

async function runWithWakeupOffset(k: number): Promise<number> {
  synthesized.length = 0;
  pacers.length = 0;
  let pushedAudioDuration = 0;
  const pacer = new RecordingPacer({
    minRemainingAudio: 3000,
    maxTextLength: 200,
  }).wrap(new DelayedEndSentenceTokenizer().stream(), () => pushedAudioDuration);
  const fakeTts = new FakeTTS();
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  const produce = async () => {
    for (let i = 0; i < REPLY.length; i += 4) {
      pacer.pushText(REPLY.slice(i, i + 4));
      await delay(3);
    }
    while (
      !(
        pacers.length &&
        synthesized.length &&
        pacers[0]!._wakeupTimer !== undefined &&
        !pacers[0]!._wakeupEvent.isSet &&
        pacers[0]!._sentences.length === 0
      )
    ) {
      await delay(3);
    }
    if (k >= 0) {
      pacer.endInput();
      for (let i = 0; i < k; i++) await nextTurn();
      pacers[0]!._wakeupEvent.set();
    } else {
      pacers[0]!._wakeupEvent.set();
      for (let i = 0; i < -k; i++) await nextTurn();
      pacer.endInput();
    }
  };

  const consume = async () => {
    for await (const event of pacer) {
      for await (const audio of fakeTts.synthesize(event.token)) {
        pushedAudioDuration += (audio.frame.samplesPerChannel / audio.frame.sampleRate) * 1000;
      }
    }
  };

  await Promise.all([produce(), consume()]);
  return synthesized.length;
}

describe('StreamPacerWrapper endInput buffered tail', () => {
  it.each([-1, 0, 1])('keeps the tail across wakeup offset %i', async (k) => {
    const requests = await runWithWakeupOffset(k);
    expect(requests, `k=${k}: expected 2 TTS requests, got ${requests}`).toBe(2);
  });
});
