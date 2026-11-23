// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { STTv2, type STTv2Options } from './stt_v2.js';

type TestSpeechStream = {
  pushFrame(frame: AudioFrame): void;
  updateOptions(opts: Partial<STTv2Options>): void;
  close(): void;
};

const SAMPLE_RATE = 16000;
// The default wait is one second, which a loaded runner can exceed on a reconnect.
const WAIT = { timeout: 4000 };
const TEST_TIMEOUT_MS = 20_000;

let server: WebSocketServer;
let stream: TestSpeechStream | undefined;
/** First sample of each audio message the server got, with the connection it came in on. */
let received: { connection: number; marker: number }[];
let connections: number;

async function startStream() {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP server');

  received = [];
  connections = 0;
  server.on('connection', (socket) => {
    const connection = connections++;
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) received.push({ connection, marker: data.readInt16LE(0) });
    });
  });

  const provider = new STTv2({
    apiKey: 'test',
    endpointUrl: `ws://127.0.0.1:${address.port}`,
    sampleRate: SAMPLE_RATE,
  });
  provider.on('error', vi.fn());
  stream = provider.stream({
    connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
  }) as unknown as TestSpeechStream;
  await vi.waitFor(() => expect(connections).toBe(1), WAIT);
  return stream;
}

/** A frame of `ms` milliseconds whose samples all equal `marker`. */
function frame(ms: number, marker = 0) {
  const samples = (SAMPLE_RATE / 1000) * ms;
  return new AudioFrame(new Int16Array(samples).fill(marker), SAMPLE_RATE, 1, samples);
}

afterEach(async () => {
  stream?.close();
  stream = undefined;
  for (const socket of server?.clients ?? []) socket.terminate();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('Deepgram STTv2 send loop', () => {
  it(
    'does not retain frames it has sent while the connection stays open',
    async () => {
      v8.setFlagsFromString('--expose-gc');
      const gc = vm.runInNewContext('gc') as () => void;
      const flux = await startStream();

      const total = 400;
      const refs: WeakRef<AudioFrame>[] = [];
      for (let i = 0; i < total; i++) {
        const sent = frame(10);
        refs.push(new WeakRef(sent));
        flux.pushFrame(sent);
      }
      // 10 ms frames go out as 50 ms messages
      await vi.waitFor(() => expect(received).toHaveLength(total / 5), WAIT);

      for (let pass = 0; pass < 3; pass++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        gc();
      }

      // No reconnect has happened, as in a normal session. A frame still held by a loop variable
      // or an in-flight read is not a leak, so allow a few.
      expect(refs.filter((ref) => ref.deref() !== undefined).length).toBeLessThanOrEqual(4);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'delivers every frame once and in order across a reconnect',
    async () => {
      const flux = await startStream();
      // 50 ms frames, so each one is exactly one message
      flux.pushFrame(frame(50, 1));
      await vi.waitFor(() => expect(received).toHaveLength(1), WAIT);

      // a frame just ahead of a reconnect request
      flux.pushFrame(frame(50, 2));
      flux.updateOptions({ numerals: true });
      await vi.waitFor(() => expect(connections).toBe(2), WAIT);

      // a frame just behind one
      flux.updateOptions({ profanityFilter: true });
      flux.pushFrame(frame(50, 3));
      await vi.waitFor(() => expect(connections).toBe(3), WAIT);

      flux.pushFrame(frame(50, 4));
      await vi.waitFor(() => expect(received.map(({ marker }) => marker)).toContain(4), WAIT);

      expect(received.map(({ marker }) => marker)).toEqual([1, 2, 3, 4]);
      expect(received.at(-1)?.connection).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});
