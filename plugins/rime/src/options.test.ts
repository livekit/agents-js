// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { endpointIdentity, getSampleRate, resolveOptions, validateEndpoint } from './options.js';
import { TTS } from './tts.js';

afterEach(() => vi.restoreAllMocks());

it('derives v1 models and uses model-specific defaults', () => {
  const coda = resolveOptions({ apiKey: 'key', websocketURL: 'wss://api.rime.ai/coda/ws' });
  expect(coda).toMatchObject({
    modelId: 'coda',
    speaker: 'astra',
    lang: 'eng',
    websocketProtocol: 'binary',
    audioFormat: 'audio/pcm',
  });
  const mist = resolveOptions({
    apiKey: 'key',
    websocketURL: 'wss://api.rime.ai/mist/ws',
    pauseBetweenBrackets: false,
  });
  expect(mist).toMatchObject({ modelId: 'mistv3', speaker: 'cove' });
});

it.each([
  'speedAlpha',
  'temperature',
  'top_p',
  'max_tokens',
  'repetition_penalty',
  'segment',
  'reduceLatency',
  'inlineSpeedAlpha',
])('rejects unsupported v1 control %s during construction and update', (key) => {
  const opts = { apiKey: 'key', websocketURL: 'wss://api.rime.ai/coda/ws' };
  expect(() => resolveOptions({ ...opts, [key]: 1 })).toThrow('not supported');
  expect(() => resolveOptions({ [key]: 1 }, resolveOptions(opts))).toThrow('not supported');
});

it.each([
  'https://rime.ai.attacker.example/tts',
  'https://attacker.example/tts',
  'wss://rime.ai.attacker.example/ws',
  'ws://api.rime.ai/coda/ws',
  'http://api.rime.ai/tts',
])('rejects credential-bearing untrusted or insecure endpoint %s', (url) => {
  expect(() => validateEndpoint(url)).toThrow();
});

it('allows explicit custom HTTPS hosts and loopback IPs', () => {
  expect(validateEndpoint('https://custom.example/tts', true).hostname).toBe('custom.example');
  expect(validateEndpoint('ws://127.0.0.1:8000/coda/ws', false, true).port).toBe('8000');
  expect(() => validateEndpoint('ws://localhost:8000/coda/ws', true, true)).toThrow();
});

it('binds model changes to a new endpoint and validates updates before applying them', async () => {
  const value = new TTS({
    apiKey: 'key',
    websocketURL: 'wss://dedicated.rime.ai/ws',
    modelId: 'coda',
  });
  for (const websocketURL of [
    'wss://dedicated.rime.ai/ws/',
    'wss://DEDICATED.rime.ai:443/ws?token=new',
  ]) {
    expect(() => value.updateOptions({ websocketURL, modelId: 'mistv3' })).toThrow(
      'model endpoint',
    );
    expect(value.model).toBe('coda');
  }
  value.updateOptions({ websocketURL: 'wss://other.rime.ai/ws', modelId: 'mistv3' });
  expect(value.model).toBe('mistv3');
  value.updateOptions({ websocketURL: 'wss://other.rime.ai/ws?token=changed' });
  expect(value.model).toBe('mistv3');
  await value.close();
});

it('normalizes endpoint identity without treating query changes as model changes', () => {
  expect(endpointIdentity('wss://HOST.rime.ai:443/ws/?token=one')).toBe(
    endpointIdentity('wss://host.rime.ai/ws?token=two'),
  );
});

it('keeps sample rates coherent after updates and preserves explicit rates', async () => {
  const value = new TTS({ apiKey: 'key', modelId: 'mistv2' });
  expect(value.sampleRate).toBe(22050);
  value.updateOptions({ modelId: 'coda' });
  expect(value.sampleRate).toBe(24000);
  value.updateOptions({ samplingRate: 16000 });
  value.updateOptions({ modelId: 'mistv3' });
  expect(value.sampleRate).toBe(16000);
  await value.close();
  expect(getSampleRate({ modelId: 'mistv2' })).toBe(22050);
});

it.each([
  { websocketURL: 'wss://api.rime.ai/coda/ws', modelId: 'coda' },
  { websocketURL: 'wss://api.rime.ai/ws' },
  { websocketURL: 'wss://api.rime.ai/coda/ws', baseURL: 'https://api.rime.ai' },
  { websocketURL: 'wss://api.rime.ai/coda/ws', useWebsocket: true },
  { websocketURL: 'wss://api.rime.ai/coda/ws', pauseBetweenBrackets: true },
  { websocketURL: 'wss://api.rime.ai/coda/ws', audioFormat: 'audio/mp3' },
  { websocketURL: 'wss://api.rime.ai/coda/ws', websocketProtocol: 'other' },
  { audioFormat: 'audio/pcm' },
  { modelId: 'mistv2', timeScaleFactor: 1 },
  { samplingRate: -1 },
])('rejects incompatible options %#', (opts) => {
  expect(() =>
    resolveOptions({ apiKey: 'key', ...opts } as Parameters<typeof resolveOptions>[0]),
  ).toThrow();
});

it('snapshots the HTTP sample rate and sends it explicitly', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.alloc(4410)));
  const value = new TTS({ apiKey: 'key', modelId: 'mistv2' });
  const stream = value.synthesize('Hello.');
  value.updateOptions({ modelId: 'coda', samplingRate: 16000 });
  for await (const frame of stream) expect(frame.frame.sampleRate).toBe(22050);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).samplingRate).toBe(22050);
  await value.close();
});

it.each(['status', 'fetch', 'body'])('sanitizes HTTP %s failures', async (mode) => {
  const secret = 'Bearer key private transcript token=secret';
  const spy = vi.spyOn(globalThis, 'fetch');
  if (mode === 'status')
    spy.mockResolvedValue(new Response(secret, { status: 401, statusText: secret }));
  else if (mode === 'fetch') spy.mockRejectedValue(new Error(secret));
  else
    spy.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(secret));
          },
        }),
      ),
    );
  const value = new TTS({ apiKey: 'key' });
  const errors: Error[] = [];
  value.on('error', (event) => errors.push(event.error));
  const stream = value.synthesize('Hello.', { maxRetry: 0, timeoutMs: 100, retryIntervalMs: 0 });
  await expect(stream.next()).resolves.toMatchObject({ done: true });
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).not.toContain(secret);
  expect(errors[0]!.cause).toBeUndefined();
  await value.close();
});
