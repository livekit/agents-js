// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
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

async function waitFor<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for promise')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function captureStreamInit(opts: { chunkLengthSchedule?: number[]; autoMode?: boolean }) {
  const { wss, baseURL } = await startWebSocketServer();
  const messages: Record<string, unknown>[] = [];
  let requestUrl = '';

  wss.on('connection', (ws, req) => {
    requestUrl = req.url ?? '';
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);

      if (messages.length >= 2) {
        ws.send(JSON.stringify({ contextId: messages[0]?.context_id, isFinal: true }));
      }
    });
  });

  const elevenlabs = new TTS({
    apiKey: 'test-key',
    baseURL,
    chunkLengthSchedule: opts.chunkLengthSchedule,
    autoMode: opts.autoMode,
  });
  const stream = elevenlabs.stream();

  try {
    stream.pushText('hello world.');
    stream.endInput();
    await waitUntil(() => messages.length >= 2);

    return {
      initPacket: messages[0]!,
      requestUrl,
    };
  } finally {
    stream.close();
    await elevenlabs.close();
    await closeWebSocketServer(wss);
  }
}

async function synthesizeWithMessages(
  sendResponses: (ws: WebSocket, messages: Record<string, unknown>[]) => void,
) {
  const { wss, baseURL } = await startWebSocketServer();
  const messages: Record<string, unknown>[] = [];

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);
      sendResponses(ws, messages);
    });
  });

  const elevenlabs = new TTS({
    apiKey: 'test-key',
    baseURL,
  });
  const stream = elevenlabs.stream();
  const events: unknown[] = [];
  const outputTask = (async () => {
    for await (const event of stream) {
      events.push(event);
    }
  })();

  try {
    stream.pushText('hello world.');
    stream.endInput();
    await waitFor(outputTask);

    return { messages, events };
  } finally {
    stream.close();
    await elevenlabs.close();
    await closeWebSocketServer(wss);
  }
}

const testPackage = '@livekit/agents-plugins-test';
const { hasInferenceCredentials } = await import(/* @vite-ignore */ testPackage);

const hasElevenlabsConfig = Boolean(process.env.ELEVEN_API_KEY && hasInferenceCredentials());

if (hasElevenlabsConfig) {
  describe('ElevenLabs', () => {
    it('runs the shared TTS integration tests', async () => {
      const { tts } = await import(/* @vite-ignore */ testPackage);

      await tts(new TTS());
    });
  });
} else {
  describe('ElevenLabs', () => {
    it.skip('requires ELEVEN_API_KEY and LiveKit cloud credentials', () => {});
  });
}

describe('ElevenLabs TTS options', () => {
  it('includes chunk length schedule in the WebSocket init packet', async () => {
    const { initPacket, requestUrl } = await captureStreamInit({
      chunkLengthSchedule: [80, 120],
    });

    expect(initPacket.generation_config).toEqual({ chunk_length_schedule: [80, 120] });
    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('false');
  });

  it('omits generation config when chunk length schedule is unset', async () => {
    const { initPacket, requestUrl } = await captureStreamInit({});

    expect(initPacket).not.toHaveProperty('generation_config');
    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('true');
  });

  it('respects explicit autoMode with chunk length schedule', async () => {
    const { requestUrl } = await captureStreamInit({
      chunkLengthSchedule: [80, 120],
      autoMode: true,
    });

    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('true');
  });
});

describe('ElevenLabs TTS websocket', () => {
  const audio = Buffer.alloc(4410).toString('base64');

  it('accepts snake-case context IDs', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            context_id: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('still accepts camel-case context IDs', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            contextId: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('ignores flush_done for active contexts', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            type: 'flush_done',
            context_id: messages[0]?.context_id,
            status_code: 206,
            done: false,
            data: '',
            flush_done: true,
          }),
        );
        ws.send(
          JSON.stringify({
            context_id: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('ignores flush_done for inactive contexts', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            type: 'flush_done',
            context_id: 'already_closed_context',
            status_code: 206,
            done: false,
            data: '',
            flush_done: true,
          }),
        );
        ws.send(
          JSON.stringify({
            context_id: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });
});
