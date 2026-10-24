// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt as sttTest } from '@livekit/agents-plugins-test';
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
  pushFrame(frame: AudioFrame): void;
  next(): Promise<IteratorResult<stt.SpeechEvent>>;
  close(): void;
};

function makeStream(opts: Partial<STTv2Options> = {}): TestSpeechStream {
  return new STTv2({ apiKey: 'test-api-key', ...opts }).stream() as unknown as TestSpeechStream;
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

describe('Deepgram STTv2 Flux events', () => {
  it('forwards TurnResumed as an interim carrying the resumed transcript', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const connection = once(server, 'connection');
    const stream = makeStream({ endpointUrl: `ws://127.0.0.1:${address.port}` });

    try {
      const [socket] = await connection;
      const audioReceived = once(socket, 'message');
      stream.pushFrame(new AudioFrame(new Int16Array(800), 16000, 1, 800));
      await audioReceived;

      for (const [event, transcript] of [
        ['StartOfTurn', 'I need to'],
        ['EagerEndOfTurn', 'I need to cancel my subscription.'],
        ['TurnResumed', 'I need to cancel my subscription please'],
      ] as const) {
        socket.send(
          JSON.stringify({
            type: 'TurnInfo',
            event,
            transcript,
            words: transcript.split(' ').map((word) => ({ word, confidence: 0.9 })),
          }),
        );
      }

      const events = await Promise.all([
        stream.next(),
        stream.next(),
        stream.next(),
        stream.next(),
      ]);
      expect(
        events.map(({ value }) => [
          value?.type,
          value?.alternatives?.map((alt: stt.SpeechData) => alt.text),
        ]),
      ).toEqual([
        [stt.SpeechEventType.START_OF_SPEECH, undefined],
        [stt.SpeechEventType.INTERIM_TRANSCRIPT, ['I need to']],
        [stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, ['I need to cancel my subscription.']],
        [stt.SpeechEventType.INTERIM_TRANSCRIPT, ['I need to cancel my subscription please']],
      ]);
    } finally {
      stream.close();
      for (const client of server.clients) client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

if (hasDeepgramApiKey) {
  describe('Deepgram STTv2 (Flux)', async () => {
    await sttTest(new STTv2(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram STTv2 (Flux)', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
