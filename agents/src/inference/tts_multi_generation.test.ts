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
 * Some inference gateway providers split a single flushed utterance into several generations
 * and send a `done` after each one, all under the same session id. A websocket probe against
 * `inworld/inworld-tts-2` answered one `session.flush` of 40 sentences with 6 `done` events,
 * the first covering 39.4s of the 201.0s the session went on to produce.
 *
 * These tests hold the gateway to that shape and pin what the client has to do with it.
 */

initializeLogger({ pretty: false });

const SAMPLE_RATE = 16000;
/** `AudioByteStream` frames at 100ms; keep the gateway's chunks frame-aligned. */
const CHUNK_MS = 100;
const SAMPLES_PER_CHUNK = (SAMPLE_RATE * CHUNK_MS) / 1000;

/** Each generation carries a distinct constant sample so a frame can be attributed to it. */
const FIRST_REPLY_SAMPLES = [1000, 1001, 1002];
const SECOND_REPLY_SAMPLE = 2000;

const CHUNKS_PER_GENERATION = 20;
const GENERATION_AUDIO_MS = CHUNKS_PER_GENERATION * CHUNK_MS;

/** Gap the gateway leaves between generations; probed inter-generation gaps reached 1.26s. */
const GENERATION_GAP_MS = 300;

/**
 * Gap used by the playback-speed case. A gateway streaming at playback speed leaves at most a
 * chunk or two unplayed, so the drain wait is only ever a few hundred milliseconds there; the
 * gap has to sit clearly outside that to keep the test off the boundary.
 */
const REALTIME_GAP_MS = 1000;

/**
 * How long the gateway takes to answer the second reply's flush. It has to be longer than
 * {@link GENERATION_GAP_MS} so that a client which released the socket at the first `done`
 * reads the first reply's leftover generations while waiting for its own audio — which is
 * exactly what happened in production.
 */
const SECOND_REPLY_START_DELAY_MS = 400;

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
 * What the gateway sends right after the last generation's `done`, while the client is still
 * deciding whether that `done` ended the flush.
 */
type FlushTerminator = 'session.closed' | 'error';

interface FlushPlan {
  /** One sample value per generation the gateway splits this flush into. */
  generations: number[];
  /** Delay before the first generation of this flush starts producing. */
  startDelayMs?: number;
  /** Terminal event to send once the last generation's `done` is out. */
  after?: FlushTerminator;
  /** Emit each chunk at playback speed instead of as a single burst. */
  paced?: boolean;
  /** Gap between this flush's generations. Defaults to {@link GENERATION_GAP_MS}. */
  gapMs?: number;
}

interface GatewayOptions {
  /** What the gateway does with each successive `session.flush`, in order. */
  flushes: FlushPlan[];
  chunksPerGeneration?: number;
}

/**
 * Gateway stand-in that answers each `session.flush` with several generations on one session,
 * emitting `done` after every generation and never resetting the session.
 */
async function startFakeGateway(options: GatewayOptions) {
  const chunks = options.chunksPerGeneration ?? CHUNKS_PER_GENERATION;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));

  const sockets: WsSocket[] = [];
  let connections = 0;
  let flushCount = 0;
  let staleFlushes = 0;
  const flushedAt: number[] = [];

  wss.on('connection', (ws: WsSocket) => {
    sockets.push(ws);
    connections++;
    const sessionId = `session-${connections}`;
    let sessionClosed = false;

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

      // A flush on a session the gateway already closed. The client only ever sends
      // `session.create` when it opens a socket, so this can only be a pooled socket being
      // reused: the transcript and the flush go into a session that is gone.
      if (sessionClosed) staleFlushes++;

      const plan = options.flushes[flushCount++];
      flushedAt.push(Date.now());
      if (!plan) return;

      void (async () => {
        if (plan.startDelayMs) await sleep(plan.startDelayMs);
        for (const [index, sample] of plan.generations.entries()) {
          if (index > 0) await sleep(plan.gapMs ?? GENERATION_GAP_MS);
          for (let i = 0; i < chunks; i++) {
            send(audioEvent(sessionId, sample));
            if (plan.paced) await sleep(CHUNK_MS);
          }
          // The session id never changes: every generation reports the same one, which is
          // why the client cannot tell a boundary from an end by session id alone.
          send(JSON.stringify({ type: 'done', session_id: sessionId }));
        }
        if (plan.after === 'session.closed') {
          sessionClosed = true;
          send(JSON.stringify({ type: 'session.closed', session_id: sessionId }));
        } else if (plan.after === 'error') {
          send(JSON.stringify({ type: 'error', message: 'provider failed mid-reply' }));
        }
      })();
    });
  });

  const { port } = wss.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    flushedAt,
    get connections() {
      return connections;
    },
    get staleFlushes() {
      return staleFlushes;
    },
    close: () => {
      for (const socket of sockets) socket.terminate();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function createTTS(baseURL: string) {
  return new TTS({
    model: 'inworld/inworld-tts-2',
    voice: 'Sarah',
    sampleRate: SAMPLE_RATE,
    baseURL,
    apiKey: 'devkey',
    apiSecret: 'secret'.padEnd(32, 'x'),
  });
}

async function synthesize(tts: TTS<string>, text: string) {
  const stream = tts.stream();
  stream.pushText(text);
  stream.endInput();

  const samples: number[] = [];
  let audioMs = 0;
  for await (const event of stream) {
    if (typeof event === 'symbol' || event.frame.samplesPerChannel === 0) continue;
    samples.push(event.frame.data[0]!);
    audioMs += (event.frame.samplesPerChannel / event.frame.sampleRate) * 1000;
  }
  await stream.close();
  return { samples: new Set(samples), audioMs, endedAt: Date.now() };
}

describe('inference TTS multi-generation flush', () => {
  let gateway: Awaited<ReturnType<typeof startFakeGateway>>;

  afterEach(async () => {
    await gateway.close();
  });

  describe('with several generations per flush', () => {
    beforeEach(async () => {
      gateway = await startFakeGateway({
        flushes: [
          { generations: FIRST_REPLY_SAMPLES },
          { generations: [SECOND_REPLY_SAMPLE], startDelayMs: SECOND_REPLY_START_DELAY_MS },
        ],
      });
    });

    it('speaks every generation of the reply, not just the first', async () => {
      const tts = createTTS(gateway.baseURL);

      const reply = await synthesize(tts, 'Tell me a long story about the lighthouse.');

      // The reply is one utterance the gateway chose to synthesize in three passes. Stopping
      // at the first `done` commits the whole transcript but speaks only a third of it.
      expect([...reply.samples].sort()).toEqual(FIRST_REPLY_SAMPLES);
      expect(reply.audioMs).toBe(FIRST_REPLY_SAMPLES.length * GENERATION_AUDIO_MS);

      await tts.close();
    }, 30_000);

    it('does not hand a later generation to the next reply', async () => {
      const tts = createTTS(gateway.baseURL);

      await synthesize(tts, 'Tell me a long story about the lighthouse.');
      const second = await synthesize(tts, 'Now tell me a joke.');

      // Releasing the socket at the first `done` puts it back in the pool while the gateway
      // is still streaming, and the next reply reads that audio as its own.
      expect(second.samples).toEqual(new Set([SECOND_REPLY_SAMPLE]));
      expect(second.audioMs).toBe(GENERATION_AUDIO_MS);

      await tts.close();
    }, 30_000);
  });

  describe('with a reply short enough to finish in one generation', () => {
    beforeEach(async () => {
      gateway = await startFakeGateway({
        flushes: [{ generations: [FIRST_REPLY_SAMPLES[0]!] }],
        chunksPerGeneration: 2,
      });
    });

    it('finalizes without waiting out the full idle grace', async () => {
      const tts = createTTS(gateway.baseURL);

      const reply = await synthesize(tts, 'Sure.');

      expect(reply.samples).toEqual(new Set([FIRST_REPLY_SAMPLES[0]]));
      // Waiting for silence is only free while there is buffered audio left to play. With
      // 200ms of audio behind it, the wait has to collapse to about that, not to the full
      // idle grace, or the agent goes quiet at the end of every short reply.
      expect(reply.endedAt - gateway.flushedAt[0]!).toBeLessThan(1000);

      await tts.close();
    }, 30_000);
  });

  describe('when the gateway closes the session after a `done`', () => {
    beforeEach(async () => {
      gateway = await startFakeGateway({
        flushes: [
          { generations: [FIRST_REPLY_SAMPLES[0]!], after: 'session.closed' },
          { generations: [SECOND_REPLY_SAMPLE] },
        ],
      });
    });

    it('finishes the reply but never returns the closed session to the pool', async () => {
      const tts = createTTS(gateway.baseURL);

      // The `done` really was the end of the flush, so this reply is complete and must not
      // be failed and retried.
      const first = await synthesize(tts, 'Tell me a long story about the lighthouse.');
      expect(first.samples).toEqual(new Set([FIRST_REPLY_SAMPLES[0]]));
      expect(first.audioMs).toBe(GENERATION_AUDIO_MS);

      const second = await synthesize(tts, 'Now tell me a joke.');
      expect(second.samples).toEqual(new Set([SECOND_REPLY_SAMPLE]));

      // `session.create` is only sent when a socket is opened, so a pooled socket keeps the
      // session the gateway has already closed. Recycling it writes the next reply's
      // transcript and flush into a session that is gone, and that reply stalls until the
      // receive timeout.
      expect(gateway.staleFlushes).toBe(0);
      expect(gateway.connections).toBe(2);

      await tts.close();
    }, 30_000);
  });

  describe('when the gateway errors after a `done`', () => {
    beforeEach(async () => {
      gateway = await startFakeGateway({
        flushes: [
          { generations: [FIRST_REPLY_SAMPLES[0]!], after: 'error' },
          { generations: [SECOND_REPLY_SAMPLE] },
        ],
      });
    });

    it('fails the attempt instead of ending the reply at the boundary', async () => {
      const tts = createTTS(gateway.baseURL);

      const reply = await synthesize(tts, 'Tell me a long story about the lighthouse.');

      // A `done` is only a candidate end of the flush, so a provider that fails while
      // preparing the next generation has left the reply unfinished. Treating that error as
      // a completion truncates the reply silently and suppresses the retry that would
      // finish it.
      expect([...reply.samples].sort()).toEqual([FIRST_REPLY_SAMPLES[0], SECOND_REPLY_SAMPLE]);
      expect(gateway.connections).toBe(2);

      await tts.close();
    }, 30_000);
  });

  describe('with generations streamed at playback speed', () => {
    beforeEach(async () => {
      gateway = await startFakeGateway({
        flushes: [{ generations: FIRST_REPLY_SAMPLES, paced: true, gapMs: REALTIME_GAP_MS }],
      });
    });

    it('ends the flush at the first `done` (known limitation)', async () => {
      const tts = createTTS(gateway.baseURL);

      const reply = await synthesize(tts, 'Tell me a long story about the lighthouse.');

      // Pinned, not desired: see `DRAIN_IDLE_TIMEOUT`. A gateway producing audio at roughly
      // playback speed leaves nothing buffered, so the drain wait collapses to about zero
      // and the first `done` ends the flush — the later generations are dropped. Lengthening
      // the wait is not the answer: the bound is what keeps this fix off the turn latency
      // path, and the providers that actually split a flush run far faster than realtime, so
      // their buffer is deep and the protection does apply.
      expect(reply.samples).toEqual(new Set([FIRST_REPLY_SAMPLES[0]]));
      expect(reply.audioMs).toBe(GENERATION_AUDIO_MS);

      await tts.close();
    }, 30_000);
  });
});
