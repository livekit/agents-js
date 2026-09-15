// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError } from '@livekit/agents';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const servers: WebSocketServer[] = [];

async function startTaskFailureServer(payload: Record<string, unknown>): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');

  server.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { event?: string };
      if (message.event !== 'task_start') return;

      socket.send(
        JSON.stringify({ event: 'task_started', session_id: 'session-123', trace_id: 'trace-123' }),
      );
      socket.send(JSON.stringify({ event: 'task_failed', trace_id: 'trace-123', data: payload }));
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Consume the complete stream.
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe('MiniMax TTS redaction', () => {
  it('keeps a failed task payload out of the emitted error', async () => {
    const baseUrl = await startTaskFailureServer({ transcript: 'secret transcript' });
    const synthesizer = new TTS({ apiKey: 'test-key', baseUrl });
    const errorEvent = new Promise<Error>((resolve) => {
      synthesizer.once('error', (event) => resolve(event.error));
    });
    const stream = synthesizer.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
    });

    stream.endInput();
    await consume(stream);
    const error = await errorEvent;

    expect(error).toBeInstanceOf(APIError);
    expect(error.message).toBe('MiniMax task failed (trace_id: trace-123)');
    expect(error.message).not.toContain('secret transcript');
    expect((error as APIError).retryable).toBe(false);
  });
});

const hasMinimaxConfig = Boolean(process.env.MINIMAX_API_KEY);

if (hasMinimaxConfig) {
  describe('MiniMax TTS', () => {
    it('constructs without throwing', () => {
      new TTS();
    });
  });
} else {
  describe('MiniMax TTS', () => {
    it.skip('requires MINIMAX_API_KEY', () => {});
  });
}
