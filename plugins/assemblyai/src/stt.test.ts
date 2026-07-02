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
