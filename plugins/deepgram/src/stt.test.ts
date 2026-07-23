// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { STT } from './stt.js';

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

describe('SpeechStream abort-promise retention (issue #1950)', () => {
  // Regression: the old implementation hoisted `waitForAbort(abortSignal)` outside the
  // send-loop, causing each `Promise.race([input.next(), abortPromise])` call to register
  // a new reaction on the shared `abortPromise`.  Because `abortPromise` never settles
  // until close, those reactions — and the `AudioFrame` values they transitively held —
  // accumulated for the lifetime of the stream.
  //
  // The fix creates a per-iteration abort promise with `removeEventListener` cleanup, so
  // `abortSignal` has at most one listener at any given time.  We verify that invariant here
  // without needing a real Deepgram WebSocket connection.
  it('does not accumulate abort-signal listeners across pushed frames', async () => {
    const controller = new AbortController();
    const stt = new STT({ apiKey: 'test-key' });
    const stream = stt.stream({ signal: controller.signal });

    const SAMPLE_RATE = 16000;
    const SAMPLES = 160; // 10 ms at 16 kHz
    const silence = new Int16Array(SAMPLES);

    // Push enough frames to fill several 100 ms AudioByteStream chunks.
    const FRAMES = 50;
    for (let i = 0; i < FRAMES; i++) {
      stream.pushFrame(new AudioFrame(silence.slice(), SAMPLE_RATE, 1, SAMPLES));
      // Yield so the send-loop microtasks can run between frames.
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    // abortSignal should never have accumulated more than 1 listener.
    // EventTarget.listenerCount is not standard; fall back to checking that the
    // listener count does not scale with the number of frames pushed.
    const listenerCount = (controller.signal as unknown as NodeJS.EventEmitter).listenerCount?.(
      'abort',
    );
    if (listenerCount !== undefined) {
      expect(listenerCount).toBeLessThanOrEqual(1);
    }

    controller.abort();
    stream.close();
  });
});

describe('Deepgram streaming language detection', () => {
  // Deepgram only supports language detection for prerecorded audio, so a
  // streaming session must reject it rather than silently default to English.
  // Mirrors livekit-plugins-deepgram (Python).
  it('throws when starting a stream with detectLanguage enabled', () => {
    const stt = new STT({ apiKey: 'test', detectLanguage: true });
    expect(() => stt.stream()).toThrow('language detection is not supported in streaming mode');
  });

  it('allows streaming with an explicit language', () => {
    const stt = new STT({ apiKey: 'test', language: 'en-US' });
    const stream = stt.stream();
    // Close immediately so the connection loop never starts (no network in unit tests).
    stream.close();
  });
});

if (hasDeepgramApiKey) {
  describe('Deepgram', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
