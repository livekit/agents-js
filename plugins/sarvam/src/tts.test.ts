// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts as agentTts } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const hasSarvamApiKey = Boolean(process.env.SARVAM_API_KEY);

describe('Sarvam TTS', () => {
  it.skipIf(!hasSarvamApiKey)('runs integration suite with real API key', async () => {
    await tts(new TTS({ apiKey: process.env.SARVAM_API_KEY }), new STT(), { streaming: false });
  });

  it('supports opting into non-streaming mode', () => {
    const nonStreamingTts = new TTS({ apiKey: 'dummy-api-key', streaming: false });

    expect(nonStreamingTts.capabilities.streaming).toBe(false);
    expect(() => nonStreamingTts.stream()).toThrow(/streaming is disabled/i);
  });

  it('delivers retry audio before the stream end after a provider error', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const receivedText: string[][] = [];
    const closedAttempts: number[] = [];
    server.on('connection', (socket) => {
      const text: string[] = [];
      const attempt = receivedText.push(text);
      socket.on('close', () => closedAttempts.push(attempt));
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: { text: string } };
        if (message.type === 'text') text.push(message.data!.text);
        if (message.type !== 'flush') return;
        if (attempt === 1) {
          socket.send(JSON.stringify({ type: 'error', data: { code: 500, message: 'try again' } }));
          return;
        }
        socket.send(
          JSON.stringify({ type: 'audio', data: { audio: Buffer.alloc(4800).toString('base64') } }),
        );
        socket.send(JSON.stringify({ type: 'event', data: { event_type: 'final' } }));
      });
    });

    const { port } = server.address() as AddressInfo;
    const provider = new TTS({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}` });
    const errors: unknown[] = [];
    provider.on('error', (error) => errors.push(error));
    const stream = provider.stream();
    const events: agentTts.SynthesizedAudio[] = [];
    try {
      stream.pushText('Read this sentence.');
      stream.endInput();
      for await (const event of stream) {
        if (event === agentTts.SynthesizeStream.END_OF_STREAM) break;
        events.push(event);
      }

      expect(closedAttempts).toContain(1);
      expect(receivedText).toEqual([['Read this sentence.'], ['Read this sentence.']]);
      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.final).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const TEXT = 'Read this sentence.';
const FINAL = JSON.stringify({ type: 'event', data: { event_type: 'final' } });
// One second of 16-bit mono PCM at the default 24 kHz, so several frames reach the output.
const AUDIO = JSON.stringify({
  type: 'audio',
  data: { audio: Buffer.alloc(48000).toString('base64') },
});

type ServerMessage = { type: string; data?: { text?: string } };

/** Starts a Sarvam stand-in that passes each message and its 1-based connection number on. */
async function startServer(
  onMessage: (socket: WebSocket, message: ServerMessage, attempt: number) => void,
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const texts: string[][] = [];
  server.on('connection', (socket) => {
    const text: string[] = [];
    const attempt = texts.push(text);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === 'text') text.push(message.data!.text!);
      onMessage(socket, message, attempt);
    });
  });
  const { port } = server.address() as AddressInfo;
  const provider = new TTS({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}` });
  const errors: unknown[] = [];
  provider.on('error', (error) => errors.push(error));
  return {
    provider,
    errors,
    texts,
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function collect(stream: agentTts.SynthesizeStream) {
  const frames: agentTts.SynthesizedAudio[] = [];
  let ended = false;
  for await (const event of stream) {
    if (event === agentTts.SynthesizeStream.END_OF_STREAM) {
      ended = true;
      break;
    }
    frames.push(event);
  }
  return { frames, ended };
}

describe('Sarvam SynthesizeStream socket close', () => {
  it.each(['open', 'ended'] as const)(
    'retries a socket that closes before audio with %s input',
    async (input) => {
      // Sarvam gets a flush only at the end of input, so open input has just sent its text.
      const lastMessage = input === 'ended' ? 'flush' : 'text';
      const server = await startServer((socket, message, attempt) => {
        if (message.type !== lastMessage) return;
        if (attempt === 1) {
          socket.close(1011);
          return;
        }
        socket.send(AUDIO);
        socket.send(FINAL);
      });
      const stream = server.provider.stream();
      try {
        stream.pushText(TEXT);
        if (input === 'ended') stream.endInput();
        else stream.flush();

        const { frames, ended } = await collect(stream);

        expect(server.texts).toEqual([[TEXT], [TEXT]]);
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.at(-1)?.final).toBe(true);
        expect(ended).toBe(true);
        expect(server.errors).toEqual([]);
      } finally {
        stream.close();
        await server.close();
      }
    },
  );

  it('ends the stream without a retry when the socket closes after audio', async () => {
    const server = await startServer((socket, message) => {
      if (message.type === 'flush') socket.send(AUDIO, () => socket.close(1011));
    });
    const stream = server.provider.stream();
    try {
      stream.pushText(TEXT);
      stream.endInput();

      const { frames, ended } = await collect(stream);

      expect(server.texts).toEqual([[TEXT]]);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.at(-1)?.final).toBe(true);
      expect(ended).toBe(true);
      expect(server.errors).toEqual([]);
    } finally {
      stream.close();
      await server.close();
    }
  });

  it.each([
    { name: 'after the flush', pushes: true, waitFor: 'flush', lateFinal: false },
    { name: 'with idle open input', pushes: false, waitFor: 'config', lateFinal: false },
    { name: 'before a late final', pushes: true, waitFor: 'flush', lateFinal: true },
  ])(
    'closes the socket without output, retry or error when cancelled $name',
    async ({ pushes, waitFor, lateFinal }) => {
      let active!: (socket: WebSocket) => void;
      const activeSocket = new Promise<WebSocket>((resolve) => (active = resolve));
      const server = await startServer((socket, message) => {
        if (message.type === waitFor) active(socket);
      });
      const stream = server.provider.stream();
      try {
        if (pushes) {
          stream.pushText(TEXT);
          stream.endInput();
        }
        const socket = await activeSocket;
        const socketClosed = once(socket, 'close');
        if (lateFinal) {
          socket.send(AUDIO);
          socket.send(FINAL);
        }

        stream.close();
        const settled = await Promise.race([
          socketClosed.then(() => 'closed'),
          new Promise((resolve) => setTimeout(() => resolve('still open'), 500)),
        ]);
        const { frames, ended } = await collect(stream);
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(settled).toBe('closed');
        expect(frames).toEqual([]);
        expect(ended).toBe(false);
        expect(server.texts).toHaveLength(1);
        expect(server.errors).toEqual([]);
      } finally {
        stream.close();
        await server.close();
      }
    },
  );
});
