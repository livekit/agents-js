// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import { initializeLogger } from '../log.js';
import { TTS } from './tts.js';

/**
 * Pins the user-visible invariant: a reply must never inherit the audio a previous, dropped
 * session never finished delivering.
 *
 * `session.closed` is the only route that reaches that leak. Once the `session.closed`
 * handler rejects the attempt instead of resolving it, the exception path in
 * `ConnectionPool.withConnection` evicts the socket by itself and this test passes with or
 * without the `sessionDrained` eviction in `SynthesizeStream.run`. Read it as coverage of
 * the behaviour, not of that eviction.
 */

initializeLogger({ pretty: false });

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Audio for the first reply and the second reply carry distinct constant samples so the
 *  test can tell, per frame, which reply's synthesis a frame actually came from. */
const REPLY_1_SAMPLE = 1000;
const REPLY_2_SAMPLE = 2000;

/** ~6s of already-synthesized audio the gateway still owes after it drops the session. */
const BACKLOG_FRAMES = 300;
const OWN_FRAMES = 25;

function audioEvent(sessionId: string, sample: number): string {
  const pcm = Buffer.alloc(SAMPLES_PER_FRAME * 2);
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    pcm.writeInt16LE(sample, i * 2);
  }
  return JSON.stringify({
    type: 'output_audio',
    session_id: sessionId,
    audio: pcm.toString('base64'),
  });
}

/**
 * Gateway stand-in for the production trace in which the first reply's session was dropped
 * with `session.closed` while ~90s of synthesis was still outstanding. On the first
 * connection it streams a short prefix, drops the session without a `done`, then keeps
 * flushing the rest of the backlog onto the same socket. Any later connection behaves
 * normally.
 */
async function startFakeGateway() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  let connections = 0;
  const sockets: WsSocket[] = [];

  wss.on('connection', (ws: WsSocket) => {
    sockets.push(ws);
    const index = ++connections;
    const sessionId = `session-${index}`;
    const sample = index === 1 ? REPLY_1_SAMPLE : REPLY_2_SAMPLE;
    let flushed = false;

    const send = (payload: string) => {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    };

    ws.on('message', async (raw: Buffer) => {
      const event = JSON.parse(raw.toString()) as { type: string };
      if (event.type === 'session.create') {
        send(JSON.stringify({ type: 'session.created', session_id: sessionId }));
        return;
      }
      if (event.type !== 'session.flush' || flushed) return;
      flushed = true;

      if (index > 1) {
        for (let i = 0; i < OWN_FRAMES; i++) send(audioEvent(sessionId, sample));
        send(JSON.stringify({ type: 'done', session_id: sessionId }));
        return;
      }

      // Reply 1: hand over a short prefix, then drop the session mid-synthesis.
      for (let i = 0; i < OWN_FRAMES; i++) send(audioEvent(sessionId, sample));
      send(JSON.stringify({ type: 'session.closed', session_id: sessionId }));
      // The synthesis that was already in flight keeps arriving on this socket.
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (let i = 0; i < BACKLOG_FRAMES; i++) send(audioEvent(sessionId, sample));
      send(JSON.stringify({ type: 'done', session_id: sessionId }));
    });
  });

  const { port } = wss.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    get connections() {
      return connections;
    },
    close: () => {
      for (const socket of sockets) socket.terminate();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

async function synthesize(tts: TTS<string>, text: string) {
  const stream = tts.stream();
  stream.pushText(text);
  stream.endInput();

  const samples = new Set<number>();
  let frames = 0;
  for await (const event of stream) {
    if (typeof event === 'symbol' || event.frame.samplesPerChannel === 0) continue;
    frames++;
    samples.add(event.frame.data[0]!);
  }
  await stream.close();
  return { frames, samples };
}

describe('inference TTS pooled socket reuse', () => {
  let gateway: Awaited<ReturnType<typeof startFakeGateway>>;

  beforeEach(async () => {
    gateway = await startFakeGateway();
  });

  afterEach(async () => {
    await gateway.close();
  });

  it('does not hand a dropped session\u2019s outstanding audio to the next reply', async () => {
    const tts = new TTS({
      model: 'inworld/inworld-tts-2',
      voice: 'Sarah',
      sampleRate: SAMPLE_RATE,
      baseURL: gateway.baseURL,
      apiKey: 'devkey',
      apiSecret: 'secret'.padEnd(32, 'x'),
    });

    const first = await synthesize(tts, 'Tell me a long story about the lighthouse.');
    expect(first.samples).toEqual(new Set([REPLY_1_SAMPLE]));

    const second = await synthesize(tts, 'Tell me a long joke about skeletons.');

    // The second reply must speak only its own synthesis, and must not inherit the
    // seconds of audio the first session never finished delivering.
    expect(second.samples).toEqual(new Set([REPLY_2_SAMPLE]));
    expect(second.frames).toBeLessThan(BACKLOG_FRAMES);
    expect(gateway.connections).toBe(2);

    await tts.close();
  }, 20_000);
});
