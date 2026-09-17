// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError } from '@livekit/agents';
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
const pcm = Buffer.alloc(9600, 0x7f);

/** Wraps `data` in a 44-byte RIFF/WAVE header (24kHz mono 16-bit). */
function wav(data: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
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
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function ttsAgainst(
  body: Buffer,
  contentType: string | undefined,
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
      opts.onRequest?.(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: contentType === undefined ? {} : { 'content-type': contentType },
      });
    },
  });
  return new TTS({ client, model: 'kokoro', responseFormat: opts.responseFormat });
}

async function collect(instance: TTS): Promise<{ audio: Buffer; errors: Error[] }> {
  const errors: Error[] = [];
  instance.on('error', (ev) => errors.push(ev.error));
  const runnerListeners = process.rawListeners('unhandledRejection');
  const rejections: unknown[] = [];
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason) => rejections.push(reason));

  const chunks: Buffer[] = [];
  try {
    for await (const ev of instance.synthesize('hello')) {
      const { data } = ev.frame;
      chunks.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }
    // let the background task settle so its rejection, if any, is delivered above
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.removeAllListeners('unhandledRejection');
    for (const listener of runnerListeners) {
      process.on('unhandledRejection', listener as NodeJS.UnhandledRejectionListener);
    }
  }

  const unexpected = rejections.find((reason) => !errors.includes(reason as Error));
  if (unexpected) throw unexpected;
  return { audio: Buffer.concat(chunks), errors };
}

describe('OpenAI TTS against an OpenAI-compatible endpoint', () => {
  it('plays a raw pcm body', async () => {
    const { audio, errors } = await collect(ttsAgainst(pcm, 'audio/pcm'));
    expect(errors).toEqual([]);
    expect(audio.equals(pcm)).toBe(true);
  });

  it('plays an unlabelled body as pcm', async () => {
    const { audio, errors } = await collect(ttsAgainst(pcm, 'application/octet-stream'));
    expect(errors).toEqual([]);
    expect(audio.equals(pcm)).toBe(true);
  });

  it('plays a body with no content type as pcm', async () => {
    const { audio, errors } = await collect(ttsAgainst(pcm, undefined));
    expect(errors).toEqual([]);
    expect(audio.equals(pcm)).toBe(true);
  });

  it('does not play a wav container header as if it were pcm', async () => {
    const { audio, errors } = await collect(ttsAgainst(wav(pcm), 'audio/wav'));
    expect(audio.length).toBe(0);
    expect(errors.map((e) => e.message).join()).toMatch(/'audio\/wav'.*cannot be played/);
  });

  it('reports an error for a compressed body instead of playing it as samples', async () => {
    const { audio, errors } = await collect(ttsAgainst(pcm, 'audio/mpeg'));
    expect(audio.length).toBe(0);
    expect(errors.map((e) => e.message).join()).toMatch(/'audio\/mpeg'.*cannot be played/);
  });

  it('fails once without retrying, since a new request would return the same format', async () => {
    let requests = 0;
    const { errors } = await collect(
      ttsAgainst(pcm, 'audio/mpeg', { onRequest: () => requests++ }),
    );
    expect(requests).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(APIError);
    expect((errors[0] as APIError).retryable).toBe(false);
  });

  it('normalises the content type before checking it', async () => {
    const { audio, errors } = await collect(ttsAgainst(wav(pcm), 'Audio/WAV; codecs=1'));
    expect(audio.length).toBe(0);
    expect(errors.map((e) => e.message).join()).toMatch(/'audio\/wav'.*cannot be played/);
  });

  it('requests pcm by default', async () => {
    let requested: string | undefined;
    await collect(
      ttsAgainst(pcm, 'audio/pcm', { onRequest: (b) => (requested = b.response_format) }),
    );
    expect(requested).toBe('pcm');
  });

  it('requests the configured response format and plays what the server declares', async () => {
    let requested: string | undefined;
    const { audio, errors } = await collect(
      ttsAgainst(pcm, 'audio/pcm', {
        responseFormat: 'wav',
        onRequest: (b) => (requested = b.response_format),
      }),
    );
    expect(requested).toBe('wav');
    // the server ignored the request and said so; its label wins over what we asked for
    expect(errors).toEqual([]);
    expect(audio.equals(pcm)).toBe(true);
  });

  it('applies a response format set through updateOptions', async () => {
    let requested: string | undefined;
    const instance = ttsAgainst(pcm, 'audio/pcm', {
      onRequest: (b) => (requested = b.response_format),
    });
    instance.updateOptions({ responseFormat: 'wav' });
    await collect(instance);
    expect(requested).toBe('wav');
  });
});
