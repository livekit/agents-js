// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STTv2, type STTv2Options } from './stt_v2.js';

type TestSpeechStream = {
  updateOptions(opts: Partial<STTv2Options>): void;
  readonly _reconnectPending: boolean;
  _liveConfig(): Record<string, string | string[] | boolean>;
  close(): void;
};

function makeStream(opts: Partial<STTv2Options> = {}): TestSpeechStream {
  return new STTv2({ apiKey: 'test-api-key', ...opts }).stream() as unknown as TestSpeechStream;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

describe('Deepgram STTv2 connection options', () => {
  it.each([
    ['numerals', 'numerals', true],
    ['profanityFilter', 'profanity_filter', true],
    ['redact', 'redact', 'numbers'],
  ] as const)('reconnects when %s changes', (field, configField, value) => {
    const stream = makeStream();

    stream.updateOptions({ [field]: value });

    expect(stream._reconnectPending).toBe(true);
    expect(stream._liveConfig()[configField]).toBe(value);
    stream.close();
  });

  it('includes formatting fields in the connection config', () => {
    const stream = makeStream({
      numerals: true,
      profanityFilter: true,
      redact: 'aggressive_numbers',
    });

    expect(stream._liveConfig()).toMatchObject({
      numerals: true,
      profanity_filter: true,
      redact: 'aggressive_numbers',
    });
    stream.close();

    const defaultStream = makeStream();
    expect(defaultStream._liveConfig()).not.toHaveProperty('numerals');
    expect(defaultStream._liveConfig()).not.toHaveProperty('profanity_filter');
    expect(defaultStream._liveConfig()).not.toHaveProperty('redact');
    defaultStream.close();
  });
});

describe('Deepgram STTv2 audio chunk duration', () => {
  it.each([0, -1, 1.5, true] as const)('rejects invalid duration %s', (audioChunkDurationMs) => {
    expect(
      () =>
        new STTv2({
          apiKey: 'test-key',
          audioChunkDurationMs: audioChunkDurationMs as unknown as number,
        }),
    ).toThrow(/audioChunkDurationMs/);
  });

  it('rejects a duration smaller than one sample', () => {
    expect(
      () => new STTv2({ apiKey: 'test-key', sampleRate: 100, audioChunkDurationMs: 1 }),
    ).toThrow(/audioChunkDurationMs/);
  });

  it('ignores runtime duration updates and rejects sample rates below one sample', () => {
    const stt = new STTv2({ apiKey: 'test-key', audioChunkDurationMs: 1 });
    expect(() =>
      stt.updateOptions({ audioChunkDurationMs: 0 } as unknown as Parameters<
        STTv2['updateOptions']
      >[0]),
    ).not.toThrow();
    expect(() => stt.updateOptions({ sampleRate: 100 })).toThrow(/audioChunkDurationMs/);
  });

  const cases = [undefined, 20, 80].flatMap((audioChunkDurationMs) =>
    [8000, 16000, 48000].flatMap((sampleRate) =>
      [400, 410].map((durationMs) => ({ audioChunkDurationMs, sampleRate, durationMs })),
    ),
  );

  it.each(cases)(
    'sends $audioChunkDurationMs ms chunks at $sampleRate Hz and preserves $durationMs ms of audio',
    async ({ audioChunkDurationMs, sampleRate, durationMs }) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(wss, 'listening');
      const endpointUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
      const audio: Buffer[] = [];
      const wire: string[] = [];

      wss.on('connection', (ws) => {
        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            audio.push(Buffer.from(data as Buffer));
            wire.push('audio');
            return;
          }
          const type = (JSON.parse(data.toString()) as { type: string }).type;
          wire.push(type);
          if (type === 'CloseStream') ws.close();
        });
      });

      const deepgram = new STTv2({
        apiKey: 'test-key',
        endpointUrl,
        sampleRate,
        ...(audioChunkDurationMs === undefined ? {} : { audioChunkDurationMs }),
      });
      const stream = deepgram.stream() as unknown as TestSpeechStream & {
        pushFrame(frame: AudioFrame): void;
        endInput(): void;
      };

      try {
        expect(stream._liveConfig()).not.toHaveProperty('audioChunkDurationMs');
        const inputSamples = sampleRate / 100;
        const inputBytes = inputSamples * 2;
        const pcm = Buffer.alloc((sampleRate * durationMs * 2) / 1000);
        for (let i = 0; i < pcm.length; i++) pcm[i] = i % 256;

        for (let offset = 0; offset < pcm.length; offset += inputBytes) {
          stream.pushFrame(
            new AudioFrame(
              new Int16Array(pcm.buffer, pcm.byteOffset + offset, inputSamples),
              sampleRate,
              1,
              inputSamples,
            ),
          );
        }
        stream.endInput();
        await waitUntil(() => wire.includes('CloseStream'));

        const chunkBytes = (sampleRate * (audioChunkDurationMs ?? 50) * 2) / 1000;
        const fullChunks = Math.floor(pcm.length / chunkBytes);
        const remainder = pcm.length % chunkBytes;
        const expectedSizes = Array<number>(fullChunks).fill(chunkBytes);
        if (remainder > 0) expectedSizes.push(remainder);

        expect(audio.map((data) => data.length)).toEqual(expectedSizes);
        expect(Buffer.concat(audio)).toEqual(pcm);
        expect(wire).toEqual([...expectedSizes.map(() => 'audio'), 'CloseStream']);
      } finally {
        stream.close();
        for (const client of wss.clients) client.close();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    },
  );
});

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

if (hasDeepgramApiKey) {
  describe('Deepgram STTv2 (Flux)', async () => {
    await stt(new STTv2(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram STTv2 (Flux)', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
