// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt as sttLib } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STTv2, type STTv2Options } from './stt_v2.js';

type TestSpeechStream = {
  updateOptions(opts: Partial<STTv2Options>): void;
  readonly _reconnectPending: boolean;
  _liveConfig(): Record<string, string | string[] | boolean>;
  close(): void;
};

function makeStream(opts: Partial<STTv2Options> = {}): TestSpeechStream {
  return new STTv2({ apiKey: 'test-api-key', ...opts }).stream() as unknown as TestSpeechStream;
}

function makeFrame(samplesPerChannel = 800, sampleRate = 16000): AudioFrame {
  return new AudioFrame(
    new Int16Array(samplesPerChannel).fill(1),
    sampleRate,
    1,
    samplesPerChannel,
  );
}

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, endpointUrl: `http://127.0.0.1:${address.port}/v2/listen` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

describe('Deepgram STTv2 connection options', () => {
  it.each([
    ['numerals', 'numerals', true],
    ['profanityFilter', 'profanity_filter', true],
    ['redact', 'redact', 'numbers'],
  ] as const)('reconnects when %s changes', (field, configField, value) => {
    const stream = makeStream();

    stream.updateOptions({ [field]: value });

    expect(stream._reconnectPending).toBe(true);
    expect(stream._liveConfig()[configField]).toBe(value);
    stream.close();
  });

  it('includes formatting fields in the connection config', () => {
    const stream = makeStream({
      numerals: true,
      profanityFilter: true,
      redact: 'aggressive_numbers',
    });

    expect(stream._liveConfig()).toMatchObject({
      numerals: true,
      profanity_filter: true,
      redact: 'aggressive_numbers',
    });
    stream.close();

    const defaultStream = makeStream();
    expect(defaultStream._liveConfig()).not.toHaveProperty('numerals');
    expect(defaultStream._liveConfig()).not.toHaveProperty('profanity_filter');
    expect(defaultStream._liveConfig()).not.toHaveProperty('redact');
    defaultStream.close();
  });
});

describe('Deepgram STTv2 speech end time', () => {
  it('maps the Flux audio-window boundary', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    wss.on('connection', (ws) => {
      ws.once('message', () => {
        ws.send(
          JSON.stringify({
            type: 'TurnInfo',
            event: 'StartOfTurn',
            request_id: 'request',
            transcript: 'hello',
            audio_window_start: 0,
            audio_window_end: 0.08,
            words: [{ word: 'hello', start: 0, end: 0.07, confidence: 1 }],
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'TurnInfo',
            event: 'EndOfTurn',
            request_id: 'request',
            transcript: 'hello',
            audio_window_start: 0,
            audio_window_end: 0.1,
            words: [{ word: 'hello', start: 0, end: 0.08, confidence: 1 }],
          }),
        );
      });
    });

    const stream = new STTv2({ apiKey: 'test-key', endpointUrl }).stream();
    try {
      stream.pushFrame(makeFrame());
      const events: sttLib.SpeechEvent[] = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type === sttLib.SpeechEventType.END_OF_SPEECH) break;
      }
      expect(events.at(-1)?.speechEndTime).toBe(stream.startTime + 80);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });
});

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

if (hasDeepgramApiKey) {
  describe('Deepgram STTv2 (Flux)', async () => {
    await stt(new STTv2(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram STTv2 (Flux)', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
