// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import { initializeLogger } from '../log.js';
import { TTS } from './tts.js';

/**
 * Treating a `done` as a generation boundary means a run now ends on a quiet timeout rather
 * than on the `done` itself, and returning the socket to the pool is gated on having reached
 * that end. Those two rules meet in one place, so the pooled socket is either kept on every
 * reply or on none, and nothing else pins which.
 *
 * These tests pin both halves as a count of gateway handshakes: a conversation of clean
 * multi-generation replies must dial once, and a session dropped mid-synthesis must dial
 * again rather than hand its socket to the next reply.
 */

initializeLogger({ pretty: false });

const SAMPLE_RATE = 16000;
/** `AudioByteStream` frames at 100ms; keep the gateway's chunks frame-aligned. */
const CHUNK_MS = 100;
const SAMPLES_PER_CHUNK = (SAMPLE_RATE * CHUNK_MS) / 1000;

const CHUNKS_PER_GENERATION = 5;
const GENERATION_AUDIO_MS = CHUNKS_PER_GENERATION * CHUNK_MS;
/** Generations per flush, matching the several `done` events the gateway answers one with. */
const GENERATIONS_PER_REPLY = 3;
const GENERATION_GAP_MS = 150;

const REPLIES = 5;

function audioEvent(sessionId: string, sample: number): string {
  const pcm = Buffer.alloc(SAMPLES_PER_CHUNK * 2);
  for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
    pcm.writeInt16LE(sample, i * 2);
  }
  return JSON.stringify({
    type: 'output_audio',
    session_id: sessionId,
    audio: pcm.toString('base64'),
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Gateway stand-in. `dropMidSynthesis` reproduces a session torn down while synthesis is
 * still outstanding: a prefix, then `session.closed` with no `done` to close the flush.
 * Otherwise every flush is served in full and the session then goes quiet, which is what a
 * probe of `inworld/inworld-tts-2` showed — several `done` events, the last one final.
 */
async function startFakeGateway(options: { dropMidSynthesis?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));

  const sockets: WsSocket[] = [];
  let connections = 0;
  let flushes = 0;

  wss.on('connection', (ws: WsSocket) => {
    sockets.push(ws);
    const sessionId = `session-${++connections}`;

    const send = (payload: string) => {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    };

    ws.on('message', (raw: Buffer) => {
      const event = JSON.parse(raw.toString()) as { type: string };
      if (event.type === 'session.create') {
        send(JSON.stringify({ type: 'session.created', session_id: sessionId }));
        return;
      }
      if (event.type !== 'session.flush') return;

      // Each reply carries a distinct constant sample so a frame can be attributed to it.
      const sample = 1000 + flushes++;

      void (async () => {
        if (options.dropMidSynthesis) {
          for (let i = 0; i < CHUNKS_PER_GENERATION; i++) send(audioEvent(sessionId, sample));
          send(JSON.stringify({ type: 'session.closed', session_id: sessionId }));
          return;
        }

        for (let generation = 0; generation < GENERATIONS_PER_REPLY; generation++) {
          if (generation > 0) await sleep(GENERATION_GAP_MS);
          for (let i = 0; i < CHUNKS_PER_GENERATION; i++) send(audioEvent(sessionId, sample));
          send(JSON.stringify({ type: 'done', session_id: sessionId }));
        }
      })();
    });
  });

  const { port } = wss.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => {
      for (const socket of sockets) socket.terminate();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** A TTS whose gateway handshakes are counted, so pool misses are observable. */
function createCountedTTS(baseURL: string, connOptions?: { maxRetry: number }) {
  const tts = new TTS({
    model: 'inworld/inworld-tts-2',
    voice: 'Sarah',
    sampleRate: SAMPLE_RATE,
    baseURL,
    apiKey: 'devkey',
    apiSecret: 'secret'.padEnd(32, 'x'),
    connOptions: connOptions
      ? { maxRetry: connOptions.maxRetry, retryIntervalMs: 0, timeoutMs: 5_000 }
      : undefined,
  });

  const counter = { dials: 0 };
  const connect = tts.connectWs.bind(tts);
  tts.connectWs = async (timeout: number) => {
    counter.dials++;
    return connect(timeout);
  };
  return { tts, counter };
}

/**
 * Consumes the stream the way `Agent.default.ttsNode` does — break at END_OF_STREAM and
 * close right away — because that is the shape reuse has to survive.
 */
async function synthesize(tts: TTS<string>, text: string) {
  const stream = tts.stream();
  stream.pushText(text);
  stream.endInput();

  const samples = new Set<number>();
  let audioMs = 0;
  let error: Error | undefined;
  try {
    for await (const event of stream) {
      if (typeof event === 'symbol') break;
      if (event.frame.samplesPerChannel === 0) continue;
      samples.add(event.frame.data[0]!);
      audioMs += (event.frame.samplesPerChannel / event.frame.sampleRate) * 1000;
    }
  } catch (e) {
    error = e as Error;
  }
  stream.close();
  return { samples, audioMs, error };
}

describe('inference TTS pooled socket reuse across a drained session', () => {
  let gateway: Awaited<ReturnType<typeof startFakeGateway>>;

  afterEach(async () => {
    await gateway.close();
  });

  it('dials once for a conversation of clean multi-generation replies', async () => {
    gateway = await startFakeGateway();
    const { tts, counter } = createCountedTTS(gateway.baseURL);

    for (let reply = 0; reply < REPLIES; reply++) {
      const spoken = await synthesize(tts, `Tell me story number ${reply}.`);

      // Guards the count below against passing on replies that never got their audio.
      expect(spoken.error).toBeUndefined();
      expect(spoken.samples).toEqual(new Set([1000 + reply]));
      expect(spoken.audioMs).toBe(GENERATIONS_PER_REPLY * GENERATION_AUDIO_MS);
    }

    // One handshake for the whole conversation: every reply after the first reused the
    // pooled socket. Waiting for the session to go quiet is what makes that safe, so
    // recycling on the quiet timeout has to keep the socket rather than evict it.
    expect(counter.dials).toBe(1);

    await tts.close();
  }, 60_000);

  it('dials again when the gateway drops the session mid-synthesis', async () => {
    gateway = await startFakeGateway({ dropMidSynthesis: true });
    const { tts, counter } = createCountedTTS(gateway.baseURL, { maxRetry: 1 });

    await synthesize(tts, 'Tell me a long story about the lighthouse.');

    // A session that never closed its flush still owes audio, so its socket must not go
    // back to the pool no matter how the reuse above is arranged: the retry has to dial.
    expect(counter.dials).toBe(2);

    await tts.close();
  }, 60_000);
});
