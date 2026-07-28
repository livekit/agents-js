// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import { initializeLogger } from '../log.js';
import { TTS } from './tts.js';

initializeLogger({ pretty: false });

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Audio for the dropped session and for the retry carry distinct constant samples so the
 *  test can tell, per frame, which attempt a frame actually came from. */
const DROPPED_SAMPLE = 1000;
const RETRY_SAMPLE = 2000;

/** Frames the gateway hands over before it drops the session mid-synthesis. */
const FRAMES_BEFORE_DROP = 25;

/** Upper bound on how long the test waits for a fresh attempt before giving up on it. */
const RECONNECT_TIMEOUT_MS = 10_000;

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

interface GatewayConnection {
  index: number;
  sessionId: string;
  transcripts: string[];
}

/**
 * Gateway stand-in for the production trace in which a session was dropped with
 * `session.closed` part-way through a long reply. The first connection streams a short
 * prefix and then drops the session without ever sending `done`; any later connection
 * behaves normally, so a fresh attempt is able to complete.
 */
async function startFakeGateway() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));

  const sockets: WsSocket[] = [];
  const connections: GatewayConnection[] = [];

  let markDropped!: () => void;
  const sessionDropped = new Promise<void>((resolve) => (markDropped = resolve));
  let markReconnected!: () => void;
  const reconnected = new Promise<void>((resolve) => (markReconnected = resolve));

  wss.on('connection', (ws: WsSocket) => {
    sockets.push(ws);
    const index = connections.length + 1;
    const connection: GatewayConnection = {
      index,
      sessionId: `session-${index}`,
      transcripts: [],
    };
    connections.push(connection);
    if (index === 2) markReconnected();

    const send = (payload: string) => {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    };

    let dropped = false;

    ws.on('message', (raw: Buffer) => {
      const event = JSON.parse(raw.toString()) as { type: string; transcript?: string };

      if (event.type === 'session.create') {
        send(JSON.stringify({ type: 'session.created', session_id: connection.sessionId }));
        return;
      }

      if (event.type === 'input_transcript') {
        connection.transcripts.push(event.transcript ?? '');
        if (index === 1 && !dropped) {
          dropped = true;
          for (let i = 0; i < FRAMES_BEFORE_DROP; i++) {
            send(audioEvent(connection.sessionId, DROPPED_SAMPLE));
          }
          send(JSON.stringify({ type: 'session.closed', session_id: connection.sessionId }));
          markDropped();
        }
        return;
      }

      if (event.type === 'session.flush') {
        // The dropped session owes nothing more, and never sends `done`.
        if (index === 1) return;
        send(audioEvent(connection.sessionId, RETRY_SAMPLE));
        send(JSON.stringify({ type: 'done', session_id: connection.sessionId }));
      }
    });
  });

  const { port } = wss.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    connections,
    sessionDropped,
    reconnected,
    close: () => {
      for (const socket of sockets) socket.terminate();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function createTTS(baseURL: string) {
  const tts = new TTS({
    model: 'inworld/inworld-tts-2',
    voice: 'Sarah',
    sampleRate: SAMPLE_RATE,
    baseURL,
    apiKey: 'devkey',
    apiSecret: 'secret'.padEnd(32, 'x'),
  });
  // A dropped session is surfaced as an error; without a listener node would rethrow it.
  tts.on('error', () => {});
  return tts;
}

describe('inference TTS dropped gateway session', () => {
  let gateway: Awaited<ReturnType<typeof startFakeGateway>>;

  beforeEach(async () => {
    gateway = await startFakeGateway();
  });

  afterEach(async () => {
    await gateway.close();
  });

  it('delivers the audio it already synthesized when the session is dropped', async () => {
    const tts = createTTS(gateway.baseURL);
    const stream = tts.stream();
    stream.pushText('Tell me a long story about the lighthouse.');
    stream.endInput();

    let droppedSamples = 0;
    let droppedSegmentFinals = 0;
    for await (const event of stream) {
      if (typeof event === 'symbol') continue;
      if (event.segmentId === 'session-1' && event.final) droppedSegmentFinals++;
      if (event.frame.data[0] === DROPPED_SAMPLE) droppedSamples += event.frame.samplesPerChannel;
    }

    // All of the audio the gateway handed over before dropping the session belongs to
    // the user's reply, including the frame `run()` holds back so it can be marked final.
    expect(droppedSamples).toBe(FRAMES_BEFORE_DROP * SAMPLES_PER_FRAME);
    // The dropped segment also has to be terminated, otherwise downstream never learns
    // that it ended.
    expect(droppedSegmentFinals).toBe(1);

    stream.close();
    await tts.close();
  }, 30_000);

  it('still synthesizes the rest of the reply after the session is dropped', async () => {
    const tts = createTTS(gateway.baseURL);
    const stream = tts.stream();

    const consumed = (async () => {
      for await (const event of stream) void event;
    })();

    stream.pushText('The lighthouse keeper woke before dawn. ');
    stream.pushText('The wind was already rising over the water. ');
    await gateway.sessionDropped;

    // The gateway dropped the session mid-reply, so the attempt failed. The rest of the
    // reply must still be synthesized, which means a fresh attempt has to pick it up.
    let giveUp: NodeJS.Timeout;
    await Promise.race([
      gateway.reconnected,
      new Promise<void>((resolve) => (giveUp = setTimeout(resolve, RECONNECT_TIMEOUT_MS))),
    ]).finally(() => clearTimeout(giveUp));

    stream.pushText('He climbed the stairs and lit the lamp. ');
    stream.endInput();
    await consumed;

    const submitted = gateway.connections
      .filter((connection) => connection.index > 1)
      .flatMap((connection) => connection.transcripts)
      .join('');
    expect(submitted).toContain('He climbed the stairs and lit the lamp.');

    stream.close();
    await tts.close();
  }, 30_000);
});
