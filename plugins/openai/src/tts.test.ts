// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents-plugins-test';
import { OpenAI } from 'openai';
import { describe, expect, it } from 'vitest';
import { STT } from './stt.js';
import { TTS, type TTSResponseFormat } from './tts.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

if (hasOpenAIApiKey) {
  describe('OpenAI', async () => {
    await tts(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('OpenAI', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}

/** 200ms of 24kHz mono 16-bit PCM. */
const pcm = Buffer.alloc(9600);

/** The same audio wrapped in a RIFF/WAVE container. */
const wav = (() => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
})();

function ttsAgainst(
  body: Buffer,
  contentType: string,
  opts: {
    responseFormat?: TTSResponseFormat;
    onRequest?: (body: { response_format?: string }) => void;
  } = {},
): TTS {
  const client = new OpenAI({
    apiKey: 'test',
    baseURL: 'https://compatible.example.com/v1',
    maxRetries: 0,
    fetch: async (_url, init) => {
      opts.onRequest?.(JSON.parse(String((init as RequestInit).body)));
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-type': contentType },
      });
    },
  });
  return new TTS({ client, model: 'kokoro', responseFormat: opts.responseFormat });
}

async function collect(instance: TTS): Promise<{ audio: Buffer; errors: Error[] }> {
  // the framework emits `error` before rethrowing; without a listener Node raises ERR_UNHANDLED_ERROR
  const errors: Error[] = [];
  instance.on('error', (ev: { error: Error }) => errors.push(ev.error));

  const chunks: Buffer[] = [];
  for await (const ev of instance.synthesize('hello')) {
    chunks.push(
      Buffer.from(ev.frame.data.buffer, ev.frame.data.byteOffset, ev.frame.data.byteLength),
    );
  }
  return { audio: Buffer.concat(chunks), errors };
}

describe('OpenAI TTS against an OpenAI-compatible endpoint', () => {
  it('plays a raw pcm body', async () => {
    const { audio } = await collect(ttsAgainst(pcm, 'audio/pcm'));
    expect(audio.subarray(0, pcm.length).equals(pcm)).toBe(true);
  });

  it('still plays a body whose content type is unknown', async () => {
    const { audio } = await collect(ttsAgainst(pcm, 'application/octet-stream'));
    expect(audio.subarray(0, pcm.length).equals(pcm)).toBe(true);
  });

  it('reports an error for a container body instead of playing the header as samples', async () => {
    const { audio, errors } = await collect(ttsAgainst(wav, 'audio/wav'));
    expect(audio.length).toBe(0);
    expect(errors.map((e) => e.message).join()).toMatch(/cannot be played as raw/);
  });

  it('reports an error for a compressed body', async () => {
    const { audio, errors } = await collect(ttsAgainst(pcm, 'audio/mpeg'));
    expect(audio.length).toBe(0);
    expect(errors.map((e) => e.message).join()).toMatch(/cannot be played as raw/);
  });

  it('requests pcm by default and honours an override', async () => {
    let body: { response_format?: string } | undefined;

    await collect(ttsAgainst(pcm, 'audio/pcm', { onRequest: (b) => (body = b) }));
    expect(body?.response_format).toBe('pcm');

    await collect(
      ttsAgainst(pcm, 'audio/pcm', { responseFormat: 'wav', onRequest: (b) => (body = b) }),
    );
    expect(body?.response_format).toBe('wav');
  });
});
