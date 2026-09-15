// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseUrl: `ws://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

describe('AssemblyAI options', () => {
  it('accepts u3-rt-pro-beta-1', () => {
    const stt = new STT({ apiKey: 'test-key', speechModel: 'u3-rt-pro-beta-1' });

    expect(stt.model).toBe('u3-rt-pro-beta-1');
  });

  it('accepts u3-pro parameters for u3-rt-pro-beta-1', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'u3-rt-pro-beta-1',
          prompt: 'medical dictation',
          agentContext: "The agent asked for the patient's name.",
          previousContextNTurns: 10,
        }),
    ).not.toThrow();
  });

  it('accepts universal-3-6-pro', () => {
    const stt = new STT({ apiKey: 'test-key', speechModel: 'universal-3-6-pro' });

    expect(stt.model).toBe('universal-3-6-pro');
  });

  it('accepts u3-pro parameters for universal-3-6-pro', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseUrl,
        speechModel: 'universal-3-6-pro',
        prompt: 'medical dictation',
        agentContext: "The agent asked for the patient's name.",
        previousContextNTurns: 10,
        interruptionDelay: 300,
        voiceFocus: 'near-field',
        mode: 'max_accuracy',
        languageCodes: ['en', 'es'],
      }).stream();

      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.searchParams.get('speech_model')).toBe('universal-3-6-pro');
      expect(url.searchParams.get('prompt')).toBe('medical dictation');
      expect(url.searchParams.get('agent_context')).toBe("The agent asked for the patient's name.");
      expect(url.searchParams.get('previous_context_n_turns')).toBe('10');
      expect(url.searchParams.get('interruption_delay')).toBe('300');
      expect(url.searchParams.get('voice_focus')).toBe('near-field');
      expect(url.searchParams.get('mode')).toBe('max_accuracy');
      expect(JSON.parse(url.searchParams.get('language_codes')!)).toEqual(['en', 'es']);
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('applies u3-pro connection defaults to universal-3-6-pro', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseUrl,
        speechModel: 'universal-3-6-pro',
      }).stream();

      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.searchParams.get('speech_model')).toBe('universal-3-6-pro');
      expect(url.searchParams.get('min_turn_silence')).toBe('100');
      expect(url.searchParams.get('max_turn_silence')).toBe('100');
      expect(url.searchParams.get('language_detection')).toBe('true');
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('allows family-only options for every u3-pro family model', () => {
    const models = [
      'u3-rt-pro',
      'u3-rt-pro-beta-1',
      'universal-3-5-pro',
      'universal-3-6-pro',
    ] as const;

    for (const speechModel of models) {
      expect(
        () =>
          new STT({
            apiKey: 'test-key',
            speechModel,
            voiceFocus: 'far-field',
            mode: 'min_latency',
            languageCodes: ['en', 'es'],
          }),
      ).not.toThrow();
    }
  });

  it('enables chat context by default for every u3-pro family model', () => {
    const models = [
      'u3-rt-pro',
      'u3-rt-pro-beta-1',
      'universal-3-5-pro',
      'universal-3-6-pro',
      'u3-pro',
    ] as const;

    for (const speechModel of models) {
      expect(new STT({ apiKey: 'test-key', speechModel }).capabilities.chatContext).toBe(true);
    }
  });

  it('requires a u3-rt-pro model for agentContext', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'universal-streaming-english',
          agentContext: 'hello',
        }),
    ).toThrow(/agentContext/);
  });

  it('requires a u3-rt-pro model for previousContextNTurns', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'universal-streaming-english',
          previousContextNTurns: 5,
        }),
    ).toThrow(/previousContextNTurns/);
  });

  it('forwards inactivity timeout to the streaming query', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseUrl,
        inactivityTimeout: 45,
      }).stream();

      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.pathname).toBe('/v3/ws');
      expect(url.searchParams.get('inactivity_timeout')).toBe('45');
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});

const hasAssemblyAIApiKey = Boolean(process.env.ASSEMBLYAI_API_KEY);

if (hasAssemblyAIApiKey) {
  describe('AssemblyAI', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('AssemblyAI', () => {
    it.skip('requires ASSEMBLYAI_API_KEY', () => {});
  });
}
