// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TTS } from './tts.js';

initializeLogger({ pretty: false, level: 'silent' });

const hasRimeConfig = Boolean(process.env.RIME_API_KEY && process.env.OPENAI_API_KEY);

function pcmChunk(byteLength: number): Uint8Array {
  const chunk = new Uint8Array(byteLength);
  for (let i = 0; i < chunk.length; i += 2) {
    chunk[i] = 1;
  }
  return chunk;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

describe('Rime TTS streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits audio before the Rime response body closes', async () => {
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    );

    const rimeTTS = new TTS({
      apiKey: 'test-rime-key',
      baseURL: 'https://rime.test/v1/rime-tts',
      modelId: 'arcana',
      speaker: 'luna',
      samplingRate: 16000,
    });

    const stream = rimeTTS.synthesize('This should stream before the response ends.');
    const firstAudio = stream.next();

    bodyController.enqueue(pcmChunk(3200));
    bodyController.enqueue(pcmChunk(3200));

    const firstResult = await withTimeout(firstAudio, 1000);
    expect(firstResult).not.toBe('timeout');
    if (firstResult === 'timeout') return;

    expect(firstResult.done).toBe(false);
    expect(firstResult.value.final).toBe(false);
    expect(firstResult.value.frame.samplesPerChannel).toBe(1600);

    bodyController.close();

    const finalResult = await stream.next();
    expect(finalResult.done).toBe(false);
    expect(finalResult.value.final).toBe(true);

    const doneResult = await stream.next();
    expect(doneResult.done).toBe(true);
  });
});

if (hasRimeConfig) {
  describe('Rime TTS', async () => {
    await tts(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('Rime TTS', () => {
    it.skip('requires RIME_API_KEY and OPENAI_API_KEY', () => {});
  });
}
