// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, initializeLogger } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

initializeLogger({ pretty: false, level: 'silent' });

const connOptions = { maxRetry: 2, retryIntervalMs: 1, timeoutMs: 1000 };

async function runWithServerMessage(message: Record<string, unknown>) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const { port } = wss.address() as AddressInfo;
  let connections = 0;
  wss.on('connection', (ws) => {
    connections++;
    ws.on('message', () => ws.send(JSON.stringify(message)));
  });

  const stt = new STT({
    apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${port}`,
    model: 'scribe_v2_realtime',
  });
  const errors: { error: Error; recoverable: boolean }[] = [];
  stt.on('error', (e) => errors.push(e as { error: Error; recoverable: boolean }));

  const stream = stt.stream({ connOptions });
  try {
    // the server answers audio, so keep sending it across reconnects
    const pump = setInterval(
      () => stream.pushFrame(new AudioFrame(new Int16Array(800).fill(1), 16000, 1, 800)),
      20,
    );
    stream.pushFrame(new AudioFrame(new Int16Array(800).fill(1), 16000, 1, 800));
    const ended = (async () => {
      for await (const _ of stream) {
        // drain until the stream stops
      }
    })();
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2000))]);
    clearInterval(pump);
    return { errors, connections };
  } finally {
    stream.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe('ElevenLabs realtime STT server errors', () => {
  it('reports an auth error without retrying it', async () => {
    const { errors, connections } = await runWithServerMessage({
      message_type: 'auth_error',
      message: 'invalid api key',
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(APIConnectionError);
    expect(errors[0]!.error.message).toContain('auth_error: invalid api key');
    expect(errors[0]!.recoverable).toBe(false);
    expect(connections).toBe(1);
  });

  it('retries a transcriber error before reporting it', async () => {
    const { errors, connections } = await runWithServerMessage({
      message_type: 'transcriber_error',
      message: 'internal failure',
    });

    expect(connections).toBe(3);
    expect(errors.at(-1)?.error.message).toContain('transcriber_error: internal failure');
  });
});
