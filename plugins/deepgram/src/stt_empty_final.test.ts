// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt as sttLib } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseUrl: `ws://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

function makeFrame(samplesPerChannel = 1600, sampleRate = 16000): AudioFrame {
  const data = new Int16Array(samplesPerChannel);
  data.fill(1);
  return new AudioFrame(data, sampleRate, 1, samplesPerChannel);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

/** Plays one script of Results per connection, returning the connection count. */
function playScripts(wss: WebSocketServer, scripts: string[][]): () => number {
  let connections = 0;
  wss.on('connection', (ws) => {
    const script = scripts[connections++] ?? [];
    // the client is listening by the time it sends audio
    ws.once('message', () => {
      for (const message of script) ws.send(message);
    });
  });
  return () => connections;
}

function results(transcript: string, opts: { isFinal: boolean; speechFinal?: boolean }): string {
  const words = transcript
    ? transcript.split(' ').map((word, i) => ({
        word,
        punctuated_word: word,
        start: i * 0.2,
        end: i * 0.2 + 0.2,
        confidence: 0.9,
      }))
    : [];
  return JSON.stringify({
    type: 'Results',
    is_final: opts.isFinal,
    speech_final: opts.speechFinal ?? false,
    channel: { alternatives: [{ transcript, confidence: transcript ? 0.9 : 0, words }] },
    metadata: { request_id: 'request-id' },
  });
}

// every script ends with a final transcript of `done`, where the collection stops
async function collectTranscripts(
  stream: ReturnType<STT['stream']>,
  onEvent: (ev: sttLib.SpeechEvent) => void = () => {},
): Promise<Array<[sttLib.SpeechEventType, string | undefined]>> {
  const seen: Array<[sttLib.SpeechEventType, string | undefined]> = [];
  for await (const ev of stream) {
    onEvent(ev);
    if (ev.type === sttLib.SpeechEventType.RECOGNITION_USAGE) continue;
    const text = ev.alternatives?.[0]?.text;
    seen.push([ev.type, text]);
    if (ev.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT && text === 'done') break;
  }
  return seen;
}

describe('Deepgram empty final results', () => {
  const { START_OF_SPEECH, INTERIM_TRANSCRIPT, FINAL_TRANSCRIPT, END_OF_SPEECH } =
    sttLib.SpeechEventType;

  it('passes an empty final through when it retracts an interim', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    playScripts(wss, [
      [
        results('Yep.', { isFinal: false }),
        results('', { isFinal: true, speechFinal: true }),
        results('done', { isFinal: true }),
      ],
    ]);

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    stream.pushFrame(makeFrame());
    try {
      expect(await collectTranscripts(stream)).toEqual([
        [START_OF_SPEECH, undefined],
        [INTERIM_TRANSCRIPT, 'Yep.'],
        [FINAL_TRANSCRIPT, ''],
        [END_OF_SPEECH, undefined],
        [START_OF_SPEECH, undefined],
        [FINAL_TRANSCRIPT, 'done'],
      ]);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('drops an empty final that has no interim to retract', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    playScripts(wss, [
      [
        // silence, then a segment whose final already carried the words
        results('', { isFinal: true }),
        results('Yep.', { isFinal: false }),
        results('Yep.', { isFinal: true }),
        results('', { isFinal: true, speechFinal: true }),
        results('done', { isFinal: true }),
      ],
    ]);

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    stream.pushFrame(makeFrame());
    try {
      expect(await collectTranscripts(stream)).toEqual([
        [START_OF_SPEECH, undefined],
        [INTERIM_TRANSCRIPT, 'Yep.'],
        [FINAL_TRANSCRIPT, 'Yep.'],
        [END_OF_SPEECH, undefined],
        [START_OF_SPEECH, undefined],
        [FINAL_TRANSCRIPT, 'done'],
      ]);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it.each([
    { name: 'an empty interim retracts the words', boundary: results('', { isFinal: false }) },
    {
      name: 'UtteranceEnd closes the utterance',
      boundary: JSON.stringify({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: 0.2 }),
    },
  ])('drops an empty final after $name', async ({ boundary }) => {
    const { wss, baseUrl } = await startWebSocketServer();
    playScripts(wss, [
      [
        results('Yep.', { isFinal: false }),
        boundary,
        results('', { isFinal: true, speechFinal: true }),
        results('done', { isFinal: true }),
      ],
    ]);

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    stream.pushFrame(makeFrame());
    try {
      const seen = await collectTranscripts(stream);
      expect(seen.filter(([type]) => type === FINAL_TRANSCRIPT)).toEqual([
        [FINAL_TRANSCRIPT, 'done'],
      ]);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it("does not retract the previous connection's interim", async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const connections = playScripts(wss, [
      [results('Yep.', { isFinal: false })],
      [results('', { isFinal: true }), results('done', { isFinal: true })],
    ]);

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    stream.pushFrame(makeFrame());
    try {
      const seen = await collectTranscripts(stream, (ev) => {
        if (ev.type !== INTERIM_TRANSCRIPT) return;
        // reconnect once the first connection's interim is out, then give the new one audio
        stream.updateOptions({ punctuate: false });
        void waitUntil(() => connections() === 2).then(() => stream.pushFrame(makeFrame()));
      });
      expect(seen).toEqual([
        [START_OF_SPEECH, undefined],
        [INTERIM_TRANSCRIPT, 'Yep.'],
        [FINAL_TRANSCRIPT, 'done'],
      ]);
      expect(connections()).toBe(2);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });
});
