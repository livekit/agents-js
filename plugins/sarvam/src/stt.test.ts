// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt as sttlib } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STT } from './stt.js';

const hasSarvamApiKey = Boolean(process.env.SARVAM_API_KEY);

async function sendSpeech(stream: sttlib.SpeechStream, silenceMs: number) {
  const wav = readFileSync(new URL('../../test/src/long.wav', import.meta.url));
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const speechBytes = Math.min(wav.length - 44, sampleRate * channels * 2 * 8);
  const pcm = Buffer.concat([
    wav.subarray(44, 44 + speechBytes),
    Buffer.alloc((sampleRate * channels * silenceMs * 2) / 1000),
  ]);
  const chunkBytes = (sampleRate * channels * 2) / 50;

  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, offset + chunkBytes);
    stream.pushFrame(
      new AudioFrame(
        new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2),
        sampleRate,
        channels,
        chunk.byteLength / 2 / channels,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Sarvam STT', () => {
  it.skipIf(!hasSarvamApiKey)('runs integration suite with real API key', async () => {
    const vad = await VAD.load();
    await stt(new STT({ apiKey: process.env.SARVAM_API_KEY }), vad, { streaming: false });
  });

  it('supports opting into non-streaming mode', () => {
    const nonStreamingStt = new STT({ apiKey: 'dummy-api-key', streaming: false });

    expect(nonStreamingStt.capabilities.streaming).toBe(false);
    expect(() => nonStreamingStt.stream()).toThrow(/streaming is disabled/i);
  });

  it.skipIf(!hasSarvamApiKey).each([
    ['saaras:v3', true],
    ['saaras:v3', false],
    ['saaras:v4', true],
    ['saaras:v4', false],
  ] as const)(
    'transcribes two utterances on one %s stream (clientFlush=%s)',
    { timeout: 60_000 },
    async (model, clientFlush) => {
      const speech = new STT({
        apiKey: process.env.SARVAM_API_KEY,
        model,
        flushSignal: true,
      });
      const stream = speech.stream();
      const finals: string[] = [];
      const collector = (async () => {
        for await (const event of stream) {
          if (event.type === sttlib.SpeechEventType.FINAL_TRANSCRIPT) {
            finals.push(event.alternatives?.[0]?.text ?? '');
          }
        }
      })();

      try {
        for (let utterance = 0; utterance < 2; utterance++) {
          await sendSpeech(stream, clientFlush ? 100 : 2000);
          if (clientFlush) stream.flush();
          await vi.waitFor(() => expect(finals.length).toBeGreaterThan(utterance), {
            timeout: 20_000,
          });
          expect(finals[utterance]?.toLowerCase()).toContain('seconds');
        }
      } finally {
        stream.close();
        await collector;
      }
    },
  );
});
