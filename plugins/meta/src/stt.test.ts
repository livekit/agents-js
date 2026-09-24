// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIError, APIStatusError, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientOptions, WebSocket } from 'ws';
import {
  DEFAULT_MODEL,
  DEFAULT_URL,
  MAX_COMPLETED_TURNS,
  STT,
  closeError,
  normalizeAccessToken,
  normalizeLanguageHint,
  speechStreamTestState,
} from './stt.js';

const CLOSE_AFTER_END = Symbol('close-after-end');
const CLOSE_1011_AFTER_END = Symbol('close-1011-after-end');
const TEST_OPTIONS = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 200 };

class Deferred {
  readonly promise: Promise<void>;
  #resolve!: () => void;
  constructor() {
    this.promise = new Promise((resolve) => (this.#resolve = resolve));
  }
  resolve() {
    this.#resolve();
  }
}

type Incoming =
  | Record<string, unknown>
  | string
  | Error
  | typeof CLOSE_AFTER_END
  | typeof CLOSE_1011_AFTER_END;

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  sentText: string[] = [];
  sentBytes: Buffer[] = [];
  sentAt: number[] = [];
  handshakeSent = new Deferred();
  handshakeAccepted = false;
  audioStarted = new Deferred();
  releaseAudio = new Deferred();
  endStreamSent = new Deferred();
  closed = false;
  sendError?: Error;
  sendDelayMs = 0;
  #incoming: Incoming[];
  #blockAudio: boolean;
  #startedIncoming = false;

  constructor(
    incoming: Incoming[] = [],
    options: { blockAudio?: boolean; sendError?: Error } = {},
  ) {
    super();
    this.#incoming = [...incoming];
    this.#blockAudio = options.blockAudio ?? false;
    this.sendError = options.sendError;
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(data: string | Buffer | ArrayBuffer | ArrayBufferView, callback?: (error?: Error) => void) {
    if (typeof data === 'string') {
      this.sentText.push(data);
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (payload.authorization) {
        this.handshakeSent.resolve();
        this.#drainIncoming();
      }
      if (payload.type === 'endStream') {
        this.endStreamSent.resolve();
        this.#drainIncoming();
      }
      callback?.();
      return;
    }

    this.audioStarted.resolve();
    const complete = () => {
      if (this.sendError) callback?.(this.sendError);
      else {
        const buffer = Buffer.isBuffer(data)
          ? Buffer.from(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        this.sentBytes.push(buffer);
        this.sentAt.push(performance.now());
        callback?.();
      }
    };
    if (this.#blockAudio) this.releaseAudio.promise.then(complete);
    else if (this.sendDelayMs) setTimeout(complete, this.sendDelayMs);
    else complete();
  }

  queueJson(payload: Record<string, unknown>) {
    this.#emitIncoming(payload);
  }

  #drainIncoming() {
    if (!this.#startedIncoming) this.#startedIncoming = true;
    while (this.#incoming.length) {
      const item = this.#incoming[0]!;
      if (
        (item === CLOSE_AFTER_END || item === CLOSE_1011_AFTER_END) &&
        !this.sentText.some(isEndStream)
      ) {
        return;
      }
      this.#incoming.shift();
      this.#emitIncoming(item);
    }
  }

  #emitIncoming(item: Incoming) {
    if (item === CLOSE_AFTER_END || item === CLOSE_1011_AFTER_END) {
      const code = item === CLOSE_AFTER_END ? 1000 : 1011;
      this.readyState = 3;
      this.emit('close', code, Buffer.from('unsafe close reason'));
      return;
    }
    if (item instanceof Error) {
      this.emit('error', item);
      return;
    }
    const text = typeof item === 'string' ? item : JSON.stringify(item);
    if (typeof item === 'object' && item.sessionId) this.handshakeAccepted = true;
    this.emit('message', Buffer.from(text), false);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.releaseAudio.resolve();
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.emit('close', 1000, Buffer.alloc(0));
    }
  }
}

function isEndStream(text: string): boolean {
  return (JSON.parse(text) as Record<string, unknown>).type === 'endStream';
}

class FakeFactory {
  readonly calls: Array<{ url: string; options: ClientOptions }> = [];
  readonly outcomes: Array<FakeWebSocket | Error>;
  constructor(outcomes: Array<FakeWebSocket | Error>) {
    this.outcomes = [...outcomes];
  }
  create = (url: string, options: ClientOptions): WebSocket => {
    this.calls.push({ url, options });
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error('no fake WebSocket outcome');
    if (outcome instanceof Error) throw outcome;
    return outcome as unknown as WebSocket;
  };
}

function websocket(events: Record<string, unknown>[] = []): FakeWebSocket {
  return new FakeWebSocket([{ sessionId: 'session-1' }, ...events, CLOSE_AFTER_END]);
}

function frame(byteLength: number, sampleRate = 24_000, channels = 1): AudioFrame {
  const samplesPerChannel = byteLength / (2 * channels);
  return new AudioFrame(new Int16Array(byteLength / 2), sampleRate, channels, samplesPerChannel);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function collect(
  provider: STT,
  options: { audio?: AudioFrame; language?: string; connOptions?: typeof TEST_OPTIONS } = {},
) {
  let streamError: Error | undefined;
  const onError = (event: Parameters<stt.STTCallbacks['error']>[0]) => (streamError = event.error);
  provider.on('error', onError);
  const stream = provider.stream({
    language: options.language,
    connOptions: options.connOptions ?? TEST_OPTIONS,
  });
  if (options.audio) stream.pushFrame(options.audio);
  stream.endInput();
  const events = await collectEvents(stream);
  provider.off('error', onError);
  return { events, stream, error: streamError };
}

async function collectEvents(stream: stt.SpeechStream): Promise<stt.SpeechEvent[]> {
  const events: stt.SpeechEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function speechEvents(events: stt.SpeechEvent[]) {
  return events.filter((event) => event.type !== stt.SpeechEventType.RECOGNITION_USAGE);
}

function summaries(events: stt.SpeechEvent[]) {
  return speechEvents(events).map((event) => [
    event.type,
    event.requestId,
    event.alternatives?.[0].text ?? '',
  ]);
}

const originalModelKey = process.env.MODEL_API_KEY;
const originalMetaKey = process.env.META_API_KEY;
afterEach(() => {
  if (originalModelKey === undefined) delete process.env.MODEL_API_KEY;
  else process.env.MODEL_API_KEY = originalModelKey;
  if (originalMetaKey === undefined) delete process.env.META_API_KEY;
  else process.env.META_API_KEY = originalMetaKey;
});

describe('Meta Muse STT', () => {
  it('constructs with source-parity capabilities and exports', () => {
    delete process.env.MODEL_API_KEY;
    delete process.env.META_API_KEY;
    expect(() => new STT()).toThrow(/MODEL_API_KEY or META_API_KEY/);
    process.env.MODEL_API_KEY = 'model-environment-key';
    process.env.META_API_KEY = 'meta-environment-key';
    const provider = new STT({ webSocketFactory: new FakeFactory([]).create });
    expect(provider.model).toBe(DEFAULT_MODEL);
    expect(provider.provider).toBe('Meta');
    expect(provider.label).toBe('meta.STT');
    expect(provider.capabilities).toEqual({
      streaming: true,
      interimResults: true,
      diarization: false,
      alignedTranscript: false,
      keyterms: false,
    });
  });

  it('falls back from blank MODEL_API_KEY to META_API_KEY', async () => {
    process.env.MODEL_API_KEY = '  ';
    process.env.META_API_KEY = ' meta-environment-key ';
    const ws = websocket();
    await collect(new STT({ webSocketFactory: new FakeFactory([ws]).create }));
    expect(JSON.parse(ws.sentText[0]!).authorization).toEqual({
      accessToken: 'Bearer meta-environment-key',
    });
  });

  it('does not fall back from an explicit blank API key', () => {
    process.env.MODEL_API_KEY = 'model-key';
    expect(() => new STT({ apiKey: ' ' })).toThrow(/MODEL_API_KEY or META_API_KEY/);
  });

  it.each([
    'ws://api.meta.ai/v1/asr/realtime',
    'https://api.meta.ai',
    '/relative',
    'wss://user:secret@api.meta.ai/v1/asr/realtime',
    'wss://api.meta.ai/v1/asr/realtime#secret',
  ])('rejects insecure, relative, credentialed, or fragmented URLs: %s', (url) => {
    expect(() => new STT({ apiKey: 'test-key', url })).toThrow(/wss/);
  });

  it('normalizes bearer access tokens', () => {
    expect(normalizeAccessToken('secret')).toBe('Bearer secret');
    expect(normalizeAccessToken('bearer secret')).toBe('Bearer secret');
    expect(normalizeAccessToken('Bearer   secret ')).toBe('Bearer secret');
    expect(() => new STT({ apiKey: 'Bearer' })).toThrow(/token after Bearer/);
  });

  it('normalizes and validates static hints', async () => {
    const ws = websocket();
    await collect(
      new STT({
        apiKey: 'test-key',
        keywords: [' Muse ', 'Muse'],
        languageBias: [' english ', 'English', 'French'],
        webSocketFactory: new FakeFactory([ws]).create,
      }),
    );
    expect(JSON.parse(ws.sentText[0]!)).toMatchObject({
      keywords: ['Muse'],
      languageBias: ['English', 'French'],
    });
    expect(() => new STT({ apiKey: 'test-key', keywords: [' '] })).toThrow(/keywords entries/);
    expect(() => new STT({ apiKey: 'test-key', languageBias: [''] })).toThrow(/languageBias/);
    expect(() => new STT({ apiKey: 'test-key', languageBias: ['en'] })).toThrow(/languageBias/);
  });

  it('maps stream languages to documented names', () => {
    expect(normalizeLanguageHint('pt_BR')).toBe('Portuguese');
    expect(normalizeLanguageHint('EN-us')).toBe('English');
    expect(normalizeLanguageHint('zh-CN')).toBe('Mandarin Chinese');
    expect(normalizeLanguageHint('fil-PH')).toBe('Tagalog');
    expect(() => normalizeLanguageHint('not a language')).toThrow(
      /unsupported Muse Voice language/,
    );
  });

  it('rejects batch recognition as non-retryable', async () => {
    const provider = new STT({ apiKey: 'test-key' });
    await expect(provider.recognize([])).rejects.toMatchObject({ retryable: false });
  });

  it('handshakes before audio and matches the Muse contract', async () => {
    const ws = new FakeWebSocket();
    const factory = new FakeFactory([ws]);
    const provider = new STT({
      apiKey: 'explicit-secret',
      keywords: ['Muse', 'Muse'],
      languageBias: ['English', 'French'],
      webSocketFactory: factory.create,
    });
    const stream = provider.stream({ language: 'fr-FR', connOptions: TEST_OPTIONS });
    stream.pushFrame(frame(3840));
    await ws.handshakeSent.promise;
    expect(ws.sentBytes).toEqual([]);
    expect(speechStreamTestState(stream).audioConsumed).toBe(false);
    ws.queueJson({ sessionId: 'session-1' });
    await ws.audioStarted.promise;
    stream.endInput();
    ws.queueJson({ type: 'audioProgress', audioProcessedMs: 0 });
    await ws.endStreamSent.promise;
    ws.emit('close', 1000, Buffer.alloc(0));
    await collectEvents(stream);
    expect(JSON.parse(ws.sentText[0]!)).toEqual({
      mode: 'ENDPOINTING',
      authorization: { accessToken: 'Bearer explicit-secret' },
      audioEncoding: 'PCM_24KHZ',
      model: 'muse-voice-transcribe-1.0',
      partialMode: 'CUMULATIVE',
      emitAudioProgress: true,
      keywords: ['Muse'],
      languageBias: ['English', 'French'],
    });
    expect(factory.calls[0]!.url).toBe(DEFAULT_URL);
    expect(JSON.stringify(factory.calls[0]!.options)).not.toContain('explicit-secret');
  });

  it('packetizes PCM16 into paced 80 ms chunks and preserves the tail', async () => {
    const ws = websocket();
    const { events } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: new FakeFactory([ws]).create }),
      { audio: frame(3840 * 2 + 100) },
    );
    expect(ws.sentBytes.map((packet) => packet.length)).toEqual([3840, 3840, 100]);
    expect(events.every((event) => !event.recognitionUsage)).toBe(true);
  });

  it('resamples 48 kHz mono input to 24 kHz wire audio', async () => {
    const ws = websocket();
    await collect(new STT({ apiKey: 'test-key', webSocketFactory: new FakeFactory([ws]).create }), {
      audio: frame(48_000 * 2 * 0.2, 48_000),
    });
    expect(ws.sentBytes.reduce((sum, packet) => sum + packet.length, 0)).toBe(24_000 * 2 * 0.2);
    expect(ws.sentBytes.map((packet) => packet.length)).toEqual([3840, 3840, 1920]);
  });

  it('flushes a tail without ending and accepts more audio', async () => {
    const ws = websocket();
    const provider = new STT({
      apiKey: 'test-key',
      webSocketFactory: new FakeFactory([ws]).create,
    });
    const stream = provider.stream({ connOptions: TEST_OPTIONS });
    stream.pushFrame(frame(1000));
    stream.flush();
    await waitUntil(() => ws.sentBytes.length === 1);
    expect(ws.sentText.some(isEndStream)).toBe(false);
    stream.pushFrame(frame(3840));
    stream.endInput();
    await collectEvents(stream);
    expect(ws.sentBytes.map((packet) => packet.length)).toEqual([1000, 3840]);
    expect(ws.sentText.filter(isEndStream)).toHaveLength(1);
  });

  it('does not retry stereo after consuming input', async () => {
    const factory = new FakeFactory([websocket(), websocket()]);
    const provider = new STT({ apiKey: 'test-key', webSocketFactory: factory.create });
    const { error } = await collect(provider, {
      audio: frame(7680, 24_000, 2),
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 },
    });
    expect(error).toMatchObject({ retryable: false });
    expect(error?.message).toMatch(/mono audio/);
    expect(factory.calls).toHaveLength(1);
  });

  it('uses absolute pacing that accounts for send time', async () => {
    const ws = websocket();
    ws.sendDelayMs = 30;
    await collect(new STT({ apiKey: 'test-key', webSocketFactory: new FakeFactory([ws]).create }), {
      audio: frame(3840 * 3),
    });
    expect(ws.sentAt).toHaveLength(3);
    expect(ws.sentAt[1]! - ws.sentAt[0]!).toBeGreaterThanOrEqual(45);
    expect(ws.sentAt[2]! - ws.sentAt[1]!).toBeGreaterThanOrEqual(45);
  });

  it('uses audio progress without duplicating sent-byte usage', async () => {
    const ws = websocket([
      { type: 'audioProgress', audioProcessedMs: 80 },
      { type: 'audioProgress', audioProcessedMs: 80 },
      { type: 'audioProgress', audioProcessedMs: 160 },
    ]);
    const { events } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: new FakeFactory([ws]).create }),
      { audio: frame(7680) },
    );
    expect(events.flatMap((event) => event.recognitionUsage?.audioDuration ?? [])).toEqual([0.16]);
  });

  it('emits usage once after each completed turn', async () => {
    const ws = websocket([
      { type: 'speechStart', turnId: 'turn-1' },
      { type: 'audioProgress', audioProcessedMs: 80 },
      { type: 'audioProgress', audioProcessedMs: 160 },
      { type: 'transcript', turnId: 'turn-1', transcript: 'hello' },
      { type: 'speechEnd', turnId: 'turn-1' },
      { type: 'speechComplete', turnId: 'turn-1', transcript: 'hello' },
      { type: 'speechStart', turnId: 'turn-2' },
      { type: 'audioProgress', audioProcessedMs: 240 },
      { type: 'audioProgress', audioProcessedMs: 400 },
      { type: 'speechEnd', turnId: 'turn-2' },
      { type: 'speechComplete', turnId: 'turn-2', transcript: 'again' },
    ]);
    const { events } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: new FakeFactory([ws]).create }),
    );
    const usage = events.filter((event) => event.recognitionUsage);
    expect(usage.map((event) => event.requestId)).toEqual(['session-1', 'session-1']);
    expect(usage.map((event) => event.recognitionUsage!.audioDuration)).toEqual([0.16, 0.24]);
    expect(events.indexOf(usage[0]!)).toBeGreaterThan(
      events.findIndex((event) => event.type === stt.SpeechEventType.END_OF_SPEECH),
    );
  });

  it('deduplicates cumulative partials/finals/end and evicts completed state', async () => {
    const ws = websocket([
      { type: 'speechStart', turnId: 1 },
      { type: 'transcript', transcript: 'hel' },
      { type: 'transcript', turnId: 1, transcript: 'hel' },
      { type: 'transcript', turnId: 1, transcript: 'hello' },
      { type: 'speechEnd', turnId: 1 },
      { type: 'speechEnd', turnId: 1 },
      { type: 'speechComplete', turnId: 1, transcript: 'hello there' },
      { type: 'speechComplete', turnId: 1, transcript: 'duplicate' },
      { type: 'speechEnd', turnId: 1 },
    ]);
    const { events, stream } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: new FakeFactory([ws]).create }),
    );
    expect(summaries(events)).toEqual([
      [stt.SpeechEventType.START_OF_SPEECH, '1', ''],
      [stt.SpeechEventType.INTERIM_TRANSCRIPT, '1', 'hel'],
      [stt.SpeechEventType.INTERIM_TRANSCRIPT, '1', 'hello'],
      [stt.SpeechEventType.FINAL_TRANSCRIPT, '1', 'hello there'],
      [stt.SpeechEventType.END_OF_SPEECH, '1', ''],
    ]);
    expect(speechStreamTestState(stream).turns.size).toBe(0);
    expect(speechStreamTestState(stream).completedTurnIds).toEqual(new Set(['1']));
    expect(events.at(-2)?.alternatives?.[0].language).toBe('');
  });

  it('bounds completed-turn tombstones', async () => {
    const events: Record<string, unknown>[] = [];
    for (let i = 0; i < MAX_COMPLETED_TURNS + 2; i++) {
      events.push(
        { type: 'speechStart', turnId: i },
        { type: 'speechEnd', turnId: i },
        { type: 'speechComplete', turnId: i, transcript: String(i) },
      );
    }
    const { stream } = await collect(
      new STT({
        apiKey: 'test-key',
        webSocketFactory: new FakeFactory([websocket(events)]).create,
      }),
    );
    expect(speechStreamTestState(stream).completedTurnIds.size).toBe(MAX_COMPLETED_TURNS);
    expect(speechStreamTestState(stream).completedTurnIds.has('0')).toBe(false);
    expect(speechStreamTestState(stream).completedTurnIds.has('1')).toBe(false);
  });

  it('globally serializes interleaved turns and usage', async () => {
    const ws = websocket([
      { type: 'speechStart', turnId: 'first' },
      { type: 'transcript', turnId: 'first', transcript: 'one' },
      { type: 'audioProgress', audioProcessedMs: 150 },
      { type: 'speechEnd', turnId: 'first' },
      { type: 'speechStart', turnId: 'second' },
      { type: 'transcript', transcript: 'two' },
      { type: 'audioProgress', audioProcessedMs: 400 },
      { type: 'speechEnd', turnId: 'second' },
      { type: 'speechComplete', turnId: 'second', transcript: 'turn two' },
      { type: 'speechComplete', turnId: 'first', transcript: 'turn one' },
    ]);
    const { events } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: new FakeFactory([ws]).create }),
    );
    expect(summaries(events)).toEqual([
      [stt.SpeechEventType.START_OF_SPEECH, 'first', ''],
      [stt.SpeechEventType.INTERIM_TRANSCRIPT, 'first', 'one'],
      [stt.SpeechEventType.FINAL_TRANSCRIPT, 'first', 'turn one'],
      [stt.SpeechEventType.END_OF_SPEECH, 'first', ''],
      [stt.SpeechEventType.START_OF_SPEECH, 'second', ''],
      [stt.SpeechEventType.INTERIM_TRANSCRIPT, 'second', 'two'],
      [stt.SpeechEventType.FINAL_TRANSCRIPT, 'second', 'turn two'],
      [stt.SpeechEventType.END_OF_SPEECH, 'second', ''],
    ]);
    expect(events.flatMap((event) => event.recognitionUsage?.audioDuration ?? [])).toEqual([
      0.15, 0.25,
    ]);
  });

  it('counts only positive audio progress deltas', async () => {
    const ws = websocket(
      [80, 200, 200, 150, 350.5].map((audioProcessedMs) => ({
        type: 'audioProgress',
        audioProcessedMs,
      })),
    );
    const { events } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: new FakeFactory([ws]).create }),
    );
    expect(events.flatMap((event) => event.recognitionUsage?.audioDuration ?? [])[0]).toBeCloseTo(
      0.3505,
    );
  });

  it('flushes pending usage before a stream error', async () => {
    const ws = new FakeWebSocket([
      { sessionId: 'session-1' },
      { type: 'audioProgress', audioProcessedMs: 240 },
      '{invalid-json',
    ]);
    const { events, error } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: new FakeFactory([ws]).create }),
    );
    expect(error?.message).toMatch(/invalid JSON/);
    expect(events.flatMap((event) => event.recognitionUsage?.audioDuration ?? [])).toEqual([0.24]);
  });

  it.each([true, -1, Number.NaN, Number.POSITIVE_INFINITY, '80', null])(
    'rejects invalid audio progress as non-retryable: %s',
    async (audioProcessedMs) => {
      const { error } = await collect(
        new STT({
          apiKey: 'test-key',
          webSocketFactory: new FakeFactory([
            websocket([{ type: 'audioProgress', audioProcessedMs }]),
          ]).create,
        }),
      );
      expect(error).toMatchObject({ retryable: false });
      expect(error?.message).toMatch(/invalid audioProcessedMs/);
    },
  );

  it('ignores an empty turnless transcript outside speech', async () => {
    const { events } = await collect(
      new STT({
        apiKey: 'test-key',
        webSocketFactory: new FakeFactory([
          websocket([{ type: 'transcript', transcript: '', final: false }]),
        ]).create,
      }),
    );
    expect(speechEvents(events)).toEqual([]);
  });

  it('rejects a turnless transcript outside an active turn without leaking it', async () => {
    const secret = 'unsafe transcript body';
    const { error } = await collect(
      new STT({
        apiKey: 'test-key',
        webSocketFactory: new FakeFactory([
          websocket([
            { type: 'speechStart', turnId: 1 },
            { type: 'speechEnd', turnId: 1 },
            { type: 'transcript', transcript: secret },
          ]),
        ]).create,
      }),
    );
    expect(error?.message).toMatch(/missing turnId outside an active turn/);
    expect(String(error)).not.toContain(secret);
  });

  it('uses the close event code and rejects incomplete turns', async () => {
    const { error } = await collect(
      new STT({
        apiKey: 'test-key',
        webSocketFactory: new FakeFactory([
          websocket([{ type: 'speechStart', turnId: 'unfinished' }]),
        ]).create,
      }),
    );
    expect(error).toMatchObject({ retryable: false });
    expect(error?.message).toMatch(/incomplete speech turns/);
  });

  it('retries pre-audio connection failures without losing input', async () => {
    const ws = websocket();
    const factory = new FakeFactory([new Error('transient connection detail'), ws]);
    const { error } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: factory.create }),
      {
        audio: frame(3840),
        connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 },
      },
    );
    expect(error).toBeUndefined();
    expect(factory.calls).toHaveLength(2);
    expect(ws.sentBytes.map((packet) => packet.length)).toEqual([3840]);
  });

  it('retries normal and transient closes during handshake', async () => {
    for (const code of [1000, 1011, 1013]) {
      const first = new FakeWebSocket();
      const second = websocket();
      const factory = new FakeFactory([first, second]);
      const result = collect(new STT({ apiKey: 'test-key', webSocketFactory: factory.create }), {
        connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 },
      });
      await first.handshakeSent.promise;
      first.emit('close', code, Buffer.from('unsafe reason'));
      const { error } = await result;
      expect(error).toBeUndefined();
      expect(factory.calls).toHaveLength(2);
    }
  });

  it('does not retry policy-violation close during handshake or leak its reason', async () => {
    const first = new FakeWebSocket();
    const factory = new FakeFactory([first, websocket()]);
    const result = collect(new STT({ apiKey: 'test-key', webSocketFactory: factory.create }), {
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 },
    });
    await first.handshakeSent.promise;
    first.emit('close', 1008, Buffer.from('unsafe reason'));
    const { error } = await result;
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({ statusCode: 1008, retryable: false });
    expect(String(error)).not.toContain('unsafe reason');
    expect(factory.calls).toHaveLength(1);
  });

  it('sends endStream on every empty-input retry attempt', async () => {
    const first = new FakeWebSocket([{ sessionId: 'session-1' }, CLOSE_1011_AFTER_END]);
    const second = websocket();
    const factory = new FakeFactory([first, second]);
    const { error } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: factory.create }),
      { connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 } },
    );
    expect(error).toBeUndefined();
    expect(first.sentText.filter(isEndStream)).toHaveLength(1);
    expect(second.sentText.filter(isEndStream)).toHaveLength(1);
  });

  it('classifies normal close before audio as retryable', () => {
    expect(closeError(1000, 'stream', true)).toMatchObject({ statusCode: 1000, retryable: true });
  });

  it.each([1000, 1011, 1013])('does not retry close %i after audio consumption', async (code) => {
    const first = new FakeWebSocket([{ sessionId: 'session-1' }], { blockAudio: true });
    first.on('message', () =>
      queueMicrotask(() => first.emit('close', code, Buffer.from('unsafe reason'))),
    );
    const factory = new FakeFactory([first, websocket()]);
    const promise = collect(new STT({ apiKey: 'test-key', webSocketFactory: factory.create }), {
      audio: frame(3840),
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 },
    });
    await first.audioStarted.promise;
    const { error } = await promise;
    expect(error).toMatchObject({ retryable: false });
    expect(String(error)).not.toContain('unsafe reason');
    expect(factory.calls).toHaveLength(1);
  });

  it('does not retry or leak post-consumption send failures', async () => {
    const first = new FakeWebSocket([{ sessionId: 'session-1' }], {
      sendError: new Error('secret send failure'),
    });
    const factory = new FakeFactory([first, websocket()]);
    const { error } = await collect(
      new STT({ apiKey: 'test-key', webSocketFactory: factory.create }),
      {
        audio: frame(3840),
        connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 },
      },
    );
    expect(error).toMatchObject({ retryable: false });
    expect(String(error)).not.toContain('secret send failure');
    expect(factory.calls).toHaveLength(1);
  });

  it('closes the socket when closed during handshake or blocked audio', async () => {
    const handshakeSocket = new FakeWebSocket();
    const handshakeStream = new STT({
      apiKey: 'test-key',
      webSocketFactory: new FakeFactory([handshakeSocket]).create,
    }).stream({ connOptions: TEST_OPTIONS });
    await handshakeSocket.handshakeSent.promise;
    handshakeStream.close();
    await waitUntil(() => handshakeSocket.closed);

    const blockedSocket = new FakeWebSocket([{ sessionId: 'session-1' }], { blockAudio: true });
    const blockedProvider = new STT({
      apiKey: 'test-key',
      webSocketFactory: new FakeFactory([blockedSocket]).create,
    });
    const blockedStream = blockedProvider.stream({ connOptions: TEST_OPTIONS });
    blockedStream.pushFrame(frame(3840));
    await blockedSocket.audioStarted.promise;
    await blockedProvider.close();
    expect(blockedSocket.closed).toBe(true);
  });

  it.each([
    ['connect-secret', Object.assign(new Error('connect-secret'), { name: 'connect-secret' })],
    [
      'provider-secret',
      new FakeWebSocket([
        { sessionId: 'session-1' },
        { type: 'error', errorCode: 'invalid_request', message: 'provider-secret' },
      ]),
    ],
    ['close-secret', new FakeWebSocket([{ sessionId: 'session-1' }])],
    ['payload-secret', new FakeWebSocket([{ sessionId: 'session-1' }, '{payload-secret'])],
  ] as const)('redacts transport/provider details: %s', async (secret, outcome) => {
    if (secret === 'close-secret' && outcome instanceof FakeWebSocket) {
      outcome.on('message', () =>
        queueMicrotask(() => outcome.emit('close', 1011, Buffer.from(secret))),
      );
    }
    const { error } = await collect(
      new STT({
        apiKey: 'api-key-secret',
        webSocketFactory: new FakeFactory([outcome]).create,
      }),
    );
    const rendered = `${String(error)}\n${JSON.stringify(error)}`;
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('api-key-secret');
    expect((error as APIError).body).toBeNull();
    expect(error?.cause).toBeUndefined();
  });

  it('redacts token and body from handshake rejection', async () => {
    const ws = new FakeWebSocket([
      { type: 'error', errorCode: 'unauthorized', message: 'credential api-key-secret rejected' },
    ]);
    const { error } = await collect(
      new STT({ apiKey: 'api-key-secret', webSocketFactory: new FakeFactory([ws]).create }),
    );
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({ statusCode: 400, body: null });
    expect(String(error)).not.toContain('api-key-secret');
    expect(String(error)).not.toContain('credential');
    expect(ws.closed).toBe(true);
  });
});
