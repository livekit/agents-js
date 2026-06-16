// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { stt } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STTv2, type STTv2Options } from './stt_v2.js';

const TEST_CONN_OPTIONS = { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 };

async function startWebSocketServer(): Promise<{
  wss: WebSocketServer;
  endpointUrl: string;
}> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));

  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind test WebSocket server');
  }

  return {
    wss,
    endpointUrl: `ws://127.0.0.1:${address.port}/v2/listen`,
  };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve, reject) => {
    wss.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 1000) {
    if (condition()) return;
    await sleep(5);
  }

  throw new Error(message);
}

function createStream(endpointUrl: string, maxRetry = 1) {
  return new STTv2({ apiKey: 'test-api-key', endpointUrl }).stream({
    connOptions: { ...TEST_CONN_OPTIONS, maxRetry },
  });
}

describe('Deepgram STTv2 WebSocket recovery', () => {
  it('reconnects when Deepgram closes the WebSocket unexpectedly', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const stream = createStream(endpointUrl);

    wss.on('connection', (ws) => {
      connections.push(ws);

      if (connections.length === 1) {
        setTimeout(() => ws.close(1011, 'unexpected close'), 10);
      }
    });

    try {
      await waitFor(
        () => connections.length === 2,
        `expected retry to open a second WebSocket, saw ${connections.length}`,
      );
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('does not reconnect after normal input end closes the WebSocket', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const messages: Array<Record<string, unknown>> = [];
    const stream = createStream(endpointUrl);

    wss.on('connection', (ws) => {
      connections.push(ws);

      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
        ws.close(1000, 'stream complete');
      });
    });

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      stream.endInput();

      await waitFor(
        () => messages.some((message) => message.type === 'CloseStream'),
        'expected client to send CloseStream',
      );
      await sleep(50);

      expect(connections).toHaveLength(1);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('treats option-update reconnects as intentional WebSocket closes', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connections: WebSocket[] = [];
    const stream = createStream(endpointUrl, 0) as stt.SpeechStream & {
      updateOptions(opts: Partial<STTv2Options>): void;
    };

    wss.on('connection', (ws) => {
      connections.push(ws);
    });

    try {
      await waitFor(() => connections.length === 1, 'expected initial WebSocket connection');

      stream.updateOptions({ keyterms: ['updated'] });

      await waitFor(
        () => connections.length === 2,
        `expected option update to reconnect once, saw ${connections.length}`,
      );
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });
});

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

if (hasDeepgramApiKey) {
  describe('Deepgram STTv2 (Flux)', async () => {
    const sileroPackage = '@livekit/agents-plugin-silero';
    const pluginsTestPackage = '@livekit/agents-plugins-test';
    const [{ VAD }, { stt: runSttTests }] = await Promise.all([
      import(/* @vite-ignore */ sileroPackage),
      import(/* @vite-ignore */ pluginsTestPackage),
    ]);

    await runSttTests(new STTv2(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram STTv2 (Flux)', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
