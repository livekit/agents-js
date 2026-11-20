// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  APIStatusError,
  VAD,
  type VADEvent,
  VADEventType,
  VADStream,
  log,
  mergeFrames,
  stt as sttLib,
} from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { type RequestListener, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TurnDetection } from './_turn_detection.js';
import { STT, type STTOptions } from './stt.js';

// Scribe rejects a commit with less audio than this since the previous one
const MIN_COMMIT_SAMPLES = 4800;

function makeFrame(samplesPerChannel = 800, sampleRate = 16000): AudioFrame {
  const data = new Int16Array(samplesPerChannel);
  data.fill(1);
  return new AudioFrame(data, sampleRate, 1, samplesPerChannel);
}

async function recognizeWords(words?: Record<string, unknown>[]) {
  const { server, baseURL } = await startHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'hello', language_code: 'en', words }));
  });

  try {
    return await new STT({ apiKey: 'test-key', baseURL }).recognize(makeFrame(), {
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
  } finally {
    await closeHttpServer(server);
  }
}

async function startHttpServer(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
  return { server, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

async function collectUntilEnd(stream: sttLib.SpeechStream): Promise<sttLib.SpeechEvent[]> {
  const events: sttLib.SpeechEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === sttLib.SpeechEventType.END_OF_SPEECH) break;
  }
  return events;
}

/** Collects every stream event until the stream closes. */
function collectAllEvents(stream: sttLib.SpeechStream): { events: sttLib.SpeechEvent[] } {
  const events: sttLib.SpeechEvent[] = [];
  void (async () => {
    for await (const event of stream) events.push(event);
  })();
  return { events };
}

function turnEvents(events: sttLib.SpeechEvent[]): sttLib.SpeechEvent[] {
  return events.filter(
    (event) =>
      event.type === sttLib.SpeechEventType.START_OF_SPEECH ||
      event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT ||
      event.type === sttLib.SpeechEventType.END_OF_SPEECH,
  );
}

function finalTexts(events: sttLib.SpeechEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT
      ? [event.alternatives?.[0]?.text ?? '']
      : [],
  );
}

/** Pushes 20 ms frames in real time, looping the source audio or sending silence. */
function createPacedFeeder(stream: sttLib.SpeechStream, source: AudioFrame) {
  const chunkSamples = Math.round(source.sampleRate / 50);
  let sourceOffset = 0;
  return async (durationInS: number, silence = false) => {
    const startedAt = Date.now();
    for (let index = 0; index < durationInS * 50; index++) {
      const data = new Int16Array(chunkSamples * source.channels);
      if (!silence) {
        for (let sample = 0; sample < data.length; sample++) {
          data[sample] = source.data[sourceOffset++ % source.data.length] ?? 0;
        }
      }
      stream.pushFrame(new AudioFrame(data, source.sampleRate, source.channels, chunkSamples));
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, startedAt + (index + 1) * 20 - Date.now())),
      );
    }
  };
}

async function processStreamEvents(
  messages: Record<string, unknown>[],
  expectedEventCount: number,
  serverVad: { vadSilenceThresholdSecs: number } | null,
  options: STTOptions = {},
): Promise<sttLib.SpeechEvent[]> {
  const { wss, baseURL } = await startWebSocketServer();
  wss.on('connection', (ws) => {
    ws.once('message', () => {
      for (const message of messages) ws.send(JSON.stringify(message));
    });
  });

  const stream = new STT({
    apiKey: 'test-key',
    baseURL,
    model: 'scribe_v2_realtime',
    serverVad,
    ...options,
  }).stream();
  const events: sttLib.SpeechEvent[] = [];
  try {
    stream.pushFrame(makeFrame());
    for await (const event of stream) {
      events.push(event);
      if (events.length === expectedEventCount) break;
    }
    return events;
  } finally {
    stream.close();
    await closeWebSocketServer(wss);
  }
}

function partialTranscript(text: string): Record<string, unknown> {
  return { message_type: 'partial_transcript', text, words: [] };
}

function committedTranscript(
  text: string,
  options: {
    withTimestamps?: boolean;
    languageCode?: string;
    words?: Record<string, unknown>[];
  } = {},
): Record<string, unknown> {
  return {
    message_type: options.withTimestamps
      ? 'committed_transcript_with_timestamps'
      : 'committed_transcript',
    text,
    words: options.words ?? [],
    ...(options.languageCode !== undefined && { language_code: options.languageCode }),
  };
}

async function realtimeConnectionUrl(options: STTOptions = {}): Promise<URL> {
  const { wss, baseURL } = await startWebSocketServer();
  let requestUrl = '';
  wss.on('connection', (_ws, req) => {
    requestUrl = req.url ?? '';
  });

  const stream = new STT({
    apiKey: 'test-key',
    baseURL,
    model: 'scribe_v2_realtime',
    ...options,
  }).stream();
  try {
    await waitUntil(() => requestUrl !== '');
    return new URL(`ws://127.0.0.1${requestUrl}`);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 10));
    stream.close();
    await closeWebSocketServer(wss);
  }
}

function interimTexts(events: sttLib.SpeechEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === sttLib.SpeechEventType.INTERIM_TRANSCRIPT
      ? [event.alternatives?.[0]?.text ?? '']
      : [],
  );
}

const TRANSCRIPT =
  'It could not have been ten seconds, and yet it seemed a long time that their hands were clasped together.';

function normalizedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function editDistance(left: string[], right: string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++) {
      current[j + 1] = Math.min(
        current[j]! + 1,
        previous[j + 1]! + 1,
        previous[j]! + (left[i] === right[j] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function wordErrorRate(hypothesis: string, reference: string): number {
  const referenceWords = normalizedWords(reference);
  if (referenceWords.length === 0) return 0;
  return (
    editDistance(referenceWords, normalizedWords(hypothesis).slice(0, referenceWords.length)) /
    referenceWords.length
  );
}

function makeIntegrationSpeech(): AudioFrame {
  const sample = readFileSync(new URL('../../test/src/long.wav', import.meta.url));
  const channels = sample.readUInt16LE(22);
  const sampleRate = sample.readUInt32LE(24);
  const pcm = new Int16Array(sample.buffer, sample.byteOffset + 44, (sample.byteLength - 44) / 2);
  const frame = new AudioFrame(pcm, sampleRate, channels, Math.trunc(pcm.length / channels));

  if (sampleRate === 24000) return frame;

  const resampler = new AudioResampler(sampleRate, 24000, channels);
  const frames = resampler.push(frame);
  frames.push(...resampler.flush());
  resampler.close();
  return mergeFrames(frames);
}

const hasElevenLabsApiKey = Boolean(process.env.ELEVEN_API_KEY);

class TestVADStream extends VADStream {
  closeCalls = 0;

  emit(type: VADEventType): void {
    this.sendVADEvent({
      type,
      samplesIndex: 0,
      timestamp: Date.now(),
      speechDuration: 0,
      silenceDuration: 0,
      frames: [],
      probability: type === VADEventType.START_OF_SPEECH ? 1 : 0,
      inferenceDuration: 0,
      speaking: type === VADEventType.START_OF_SPEECH,
      rawAccumulatedSilence: 0,
      rawAccumulatedSpeech: 0,
    });
  }

  override close(): void {
    this.closeCalls += 1;
    super.close();
  }

  /** Reads what a VAD implementation would receive until the input ends. */
  async readInput(): Promise<AudioFrame[]> {
    const frames: AudioFrame[] = [];
    while (true) {
      const { done, value } = await this.inputReader.read();
      if (done) return frames;
      if (value !== VADStream.FLUSH_SENTINEL) frames.push(value);
    }
  }
}

class TestVAD extends VAD {
  label = 'test.VAD';
  streams: TestVADStream[] = [];

  constructor(private readonly failStart = false) {
    super({ updateInterval: 100 });
  }

  stream(): TestVADStream {
    if (this.failStart) throw new Error('VAD start failed');
    const stream = new TestVADStream(this);
    this.streams.push(stream);
    return stream;
  }
}

class StuckSpeakingVAD extends VAD {
  label = 'test.StuckSpeakingVAD';

  constructor() {
    super({ updateInterval: 100 });
  }

  stream(): VADStream {
    return new (class extends TestVADStream {
      #started = false;

      override pushFrame(frame: AudioFrame): void {
        super.pushFrame(frame);
        if (!this.#started) {
          this.#started = true;
          this.emit(VADEventType.START_OF_SPEECH);
        }
      }
    })(this);
  }
}

describe('ElevenLabs STT integration', () => {
  it.skipIf(!hasElevenLabsApiKey)(
    'recognizes speech with the real ElevenLabs API',
    async () => {
      const eleven = new STT();
      const event = await eleven.recognize(makeIntegrationSpeech(), {
        connOptions: { maxRetry: 2, retryIntervalMs: 2000, timeoutMs: 10000 },
      });

      expect(event.type).toBe(sttLib.SpeechEventType.FINAL_TRANSCRIPT);
      expect(wordErrorRate(event.alternatives?.[0]?.text ?? '', TRANSCRIPT)).toBeLessThanOrEqual(
        0.25,
      );
    },
    60_000,
  );

  it.skipIf(!hasElevenLabsApiKey)(
    'preserves a live Scribe v3 turn with server turn prediction',
    async () => {
      const stream = new STT({
        model: 'scribe_v3_live',
        commitStrategy: 'turn_prediction',
        serverVad: { vadSilenceThresholdSecs: 1 },
        languageCode: 'en',
        includeLanguageDetection: false,
      }).stream({ connOptions: { maxRetry: 2, retryIntervalMs: 2000, timeoutMs: 10000 } });
      // Scribe transcribes at about real time, so pace a clip that covers the reference sentence.
      const feed = createPacedFeeder(stream, makeIntegrationSpeech());
      const { events } = collectAllEvents(stream);
      try {
        await feed(12);
        await feed(4, true);
        await waitUntil(
          () => turnEvents(events).at(-1)?.type === sttLib.SpeechEventType.END_OF_SPEECH,
          10_000,
        );
        expect(wordErrorRate(finalTexts(events).join(' '), TRANSCRIPT)).toBeLessThanOrEqual(0.25);
      } finally {
        stream.close();
      }
    },
    60_000,
  );

  it.skipIf(!hasElevenLabsApiKey)(
    'keeps a forced Scribe v3 segment open and eventually ends with stuck local VAD',
    async () => {
      const decisions = vi.spyOn(TurnDetection.prototype, 'onCommittedTranscript');
      const stream = new STT({
        model: 'scribe_v3_live',
        commitStrategy: 'turn_prediction',
        serverVad: { vadSilenceThresholdSecs: 2 },
        vad: new StuckSpeakingVAD(),
        languageCode: 'en',
        includeTimestamps: true,
        includeLanguageDetection: false,
      }).stream({ connOptions: { maxRetry: 2, retryIntervalMs: 2000, timeoutMs: 10000 } });
      const feed = createPacedFeeder(stream, makeIntegrationSpeech());
      const { events } = collectAllEvents(stream);
      const isEndOfSpeech = (event: sttLib.SpeechEvent) =>
        event.type === sttLib.SpeechEventType.END_OF_SPEECH;

      try {
        await feed(40);
        // The provider forces a commit after about 36 seconds; the guard must defer it.
        const suppressed = decisions.mock.results.filter(
          (result) => result.type === 'return' && result.value === true,
        );
        expect(suppressed.length).toBeGreaterThan(0);
        expect(finalTexts(events).length).toBeGreaterThan(0);
        expect(events.some(isEndOfSpeech)).toBe(false);

        await feed(5, true);
        await waitUntil(() => events.some(isEndOfSpeech), 10_000);
        // Keep observing so a duplicate end of speech would be caught.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const endpoints = events.filter(isEndOfSpeech);
        expect(endpoints).toHaveLength(1);
        expect(turnEvents(events).at(-1)).toBe(endpoints[0]);
      } finally {
        decisions.mockRestore();
        stream.close();
      }
    },
    90_000,
  );
});

describe('ElevenLabs STT', () => {
  it.each([
    [undefined, undefined, 'manual'],
    [undefined, null, 'manual'],
    [undefined, {}, 'vad'],
    ['manual', {}, 'manual'],
    ['vad', null, 'vad'],
    ['turn_prediction', undefined, 'turn_prediction'],
    ['turn_prediction', null, 'turn_prediction'],
    ['turn_prediction', {}, 'turn_prediction'],
  ] as const)(
    'resolves commit strategy %s with server VAD %j to %s',
    async (commitStrategy, serverVad, expected) => {
      const options: STTOptions = {
        model: 'scribe_v3_live',
        ...(commitStrategy !== undefined && { commitStrategy }),
        ...(serverVad !== undefined && { serverVad }),
      };
      const instance = new STT({ apiKey: 'test-key', ...options });
      const url = await realtimeConnectionUrl(options);
      expect(url.searchParams.get('commit_strategy')).toBe(expected);
      expect(instance.capabilities.manualFlush).toBe(expected === 'manual');
    },
  );

  it.each([
    ['scribe_v2_realtime', undefined, true],
    ['scribe_v2_realtime', null, true],
    ['scribe_v2_realtime', {}, false],
    ['scribe_v2', undefined, false],
  ] as const)('sets manualFlush for model=%s serverVad=%j', (model, serverVad, expected) => {
    const instance = new STT({
      apiKey: 'test-key',
      model,
      ...(serverVad !== undefined && { serverVad }),
    });
    expect(instance.capabilities.manualFlush).toBe(expected);
  });

  it('tracks server VAD updates when no explicit strategy is set', () => {
    const instance = new STT({ apiKey: 'test-key', model: 'scribe_v2_realtime' });
    instance.updateOptions({ serverVad: {} });
    expect(instance.capabilities.manualFlush).toBe(false);
    instance.updateOptions({ serverVad: null });
    expect(instance.capabilities.manualFlush).toBe(true);
  });

  it('passes server VAD fallback options with turn prediction', async () => {
    const url = await realtimeConnectionUrl({
      model: 'scribe_v3_live',
      commitStrategy: 'turn_prediction',
      serverVad: {
        vadSilenceThresholdSecs: 2,
        vadThreshold: 0.3,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 200,
      },
    });
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      commit_strategy: 'turn_prediction',
      vad_silence_threshold_secs: '2',
      vad_threshold: '0.3',
      min_speech_duration_ms: '100',
      min_silence_duration_ms: '200',
    });
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'selects one plain/timestamped final and emits exactly one EOS (timestamps=%s, detection=%s)',
    async (includeTimestamps, includeLanguageDetection) => {
      const words = [{ text: 'hello', start: 0.1, end: 0.4 }];
      const events = await processStreamEvents(
        [
          { ...partialTranscript('hello'), turn_probability: 0.08 },
          { ...partialTranscript('hello'), turn_probability: 0.95 },
          committedTranscript('hello', { words }),
          committedTranscript('hello', { withTimestamps: true, words }),
        ],
        4,
        null,
        {
          model: 'scribe_v3_live',
          commitStrategy: 'turn_prediction',
          languageCode: 'en',
          includeTimestamps,
          includeLanguageDetection,
        },
      );
      expect(events.map((event) => event.type)).toEqual([
        sttLib.SpeechEventType.START_OF_SPEECH,
        sttLib.SpeechEventType.INTERIM_TRANSCRIPT,
        sttLib.SpeechEventType.FINAL_TRANSCRIPT,
        sttLib.SpeechEventType.END_OF_SPEECH,
      ]);
      expect(
        events.filter((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === sttLib.SpeechEventType.END_OF_SPEECH),
      ).toHaveLength(1);
      expect(events.at(-1)?.alternatives?.[0]?.text).toBe('hello');
    },
  );

  it.each(['scribe_v1', 'scribe_v2', 'scribe_v2_realtime', 'scribe_v3'])(
    'rejects turn prediction for %s without changing existing options',
    (model) => {
      expect(
        () => new STT({ apiKey: 'test-key', model, commitStrategy: 'turn_prediction' }),
      ).toThrow('turn_prediction is only supported for scribe_v3_live');
      const instance = new STT({ apiKey: 'test-key', model });
      expect(() =>
        instance.updateOptions({ commitStrategy: 'turn_prediction', serverVad: {} }),
      ).toThrow('turn_prediction is only supported for scribe_v3_live');
      expect(instance.capabilities.manualFlush).toBe(model === 'scribe_v2_realtime');
    },
  );

  it.each([
    ['scribe_v3_live', 'turn_prediction', false, undefined, true],
    ['scribe_v3_live', 'turn_prediction', false, {}, true],
    ['scribe_v3_live', 'turn_prediction', true, undefined, false],
    ['scribe_v3_live', 'manual', false, undefined, false],
    ['scribe_v2_realtime', 'vad', false, undefined, false],
  ] as const)(
    'warns for missing local VAD only when required (%s, %s, %s, %j)',
    (model, commitStrategy, localVad, serverVad, warns) => {
      const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
      new STT({
        apiKey: 'test-key',
        model,
        commitStrategy,
        ...(serverVad !== undefined && { serverVad }),
        ...(localVad && { vad: new TestVAD() }),
      });
      expect(
        warn.mock.calls.some((call) => String(call.at(-1)).includes('approximately 36 seconds')),
      ).toBe(warns);
      warn.mockRestore();
    },
  );

  it.each(['start', 'pushFrame', 'inference', 'endInput'] as const)(
    'continues transcription after local VAD %s failure',
    async (failurePoint) => {
      class FailingStream extends TestVADStream {
        override pushFrame(frame: AudioFrame): void {
          if (failurePoint === 'pushFrame') throw new Error('VAD push failed');
          super.pushFrame(frame);
        }

        override endInput(): void {
          if (failurePoint === 'endInput') throw new Error('VAD end input failed');
          super.endInput();
        }

        override next(): Promise<IteratorResult<VADEvent>> {
          if (failurePoint === 'inference')
            return Promise.reject(new Error('VAD inference failed'));
          return super.next();
        }
      }

      class FailingVAD extends VAD {
        label = 'test.FailingVAD';

        constructor() {
          super({ updateInterval: 100 });
        }

        stream(): VADStream {
          if (failurePoint === 'start') throw new Error('VAD start failed');
          return new FailingStream(this);
        }
      }

      const { wss, baseURL } = await startWebSocketServer();
      const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
      let receivedAudio = false;
      wss.on('connection', (ws) => {
        ws.once('message', () => {
          receivedAudio = true;
          ws.send(JSON.stringify({ ...partialTranscript('hello'), turn_probability: 0 }));
          ws.send(JSON.stringify(committedTranscript('hello')));
          ws.send(
            JSON.stringify(
              committedTranscript('hello', {
                withTimestamps: true,
                words: [{ text: 'hello', start: 0.1, end: 0.4 }],
              }),
            ),
          );
        });
      });
      const stream = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v3_live',
        commitStrategy: 'turn_prediction',
        vad: new FailingVAD(),
        languageCode: 'en',
        includeTimestamps: true,
        includeLanguageDetection: false,
      }).stream();
      try {
        stream.pushFrame(makeFrame());
        if (failurePoint === 'endInput') {
          await waitUntil(() => receivedAudio);
          stream.endInput();
        }
        const events = await collectUntilEnd(stream);
        expect(events.at(-1)?.type).toBe(sttLib.SpeechEventType.END_OF_SPEECH);
        expect(events.at(-2)?.alternatives?.[0]?.text).toBe('hello');
        expect(stream._failed).toBe(false);
        expect(
          warn.mock.calls.filter((call) =>
            String(call.at(-1)).includes('disabling forced-commit guard'),
          ),
        ).toHaveLength(1);
      } finally {
        stream.close();
        warn.mockRestore();
        await closeWebSocketServer(wss);
      }
    },
  );

  it('warns once when enabling turn prediction and not for unrelated updates', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const instance = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v3_live' });
    const stream = instance.stream();
    try {
      instance.updateOptions({ commitStrategy: 'turn_prediction' });
      expect(
        warn.mock.calls.filter((call) => String(call.at(-1)).includes('approximately 36 seconds')),
      ).toHaveLength(1);
      warn.mockClear();
      instance.updateOptions({ keyterms: ['LiveKit'] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      stream.close();
      warn.mockRestore();
      await closeWebSocketServer(wss);
    }
  });

  it.each([{}, { tagAudioEvents: false }, { keyterms: ['LiveKit'] }])(
    'preserves a manualFlush override across unrelated update %j',
    (options) => {
      const instance = new STT({ apiKey: 'test-key', model: 'scribe_v2_realtime' });
      instance.capabilities.manualFlush = false;
      instance.updateOptions(options);
      expect(instance.capabilities.manualFlush).toBe(false);
    },
  );

  it('updates commit strategy across sibling streams and capabilities', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const urls: string[] = [];
    wss.on('connection', (_ws, req) => urls.push(req.url ?? ''));
    const instance = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v3_live' });
    const streams = [instance.stream(), instance.stream()];
    try {
      await waitUntil(() => urls.length === 2);
      streams[0]!.updateOptions({ commitStrategy: 'turn_prediction' });
      await waitUntil(() => urls.length === 4, 2000);
      expect(instance.capabilities.manualFlush).toBe(false);
      expect(
        urls
          .slice(2)
          .every(
            (url) =>
              new URL(`ws://localhost${url}`).searchParams.get('commit_strategy') ===
              'turn_prediction',
          ),
      ).toBe(true);
      expect(
        warn.mock.calls.some((call) => String(call.at(-1)).includes('approximately 36 seconds')),
      ).toBe(true);
    } finally {
      streams.forEach((stream) => stream.close());
      warn.mockRestore();
      await closeWebSocketServer(wss);
    }
  });

  it('reconnects for every STT-level strategy update and preserves explicit strategy precedence', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_ws, req) => urls.push(req.url ?? ''));
    const instance = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v3_live' });
    const stream = instance.stream();
    try {
      await waitUntil(() => urls.length === 1);
      for (const strategy of ['turn_prediction', 'manual', 'vad'] as const) {
        instance.updateOptions({ commitStrategy: strategy });
        await waitUntil(
          () => urls.length === 2 + ['turn_prediction', 'manual', 'vad'].indexOf(strategy),
        );
        expect(instance.capabilities.manualFlush).toBe(strategy === 'manual');
        expect(new URL(`ws://localhost${urls.at(-1)}`).searchParams.get('commit_strategy')).toBe(
          strategy,
        );
      }
      instance.updateOptions({ serverVad: null });
      await waitUntil(() => urls.length === 5);
      expect(instance.capabilities.manualFlush).toBe(false);
      expect(new URL(`ws://localhost${urls.at(-1)}`).searchParams.get('commit_strategy')).toBe(
        'vad',
      );
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('validates a stream strategy update before changing server VAD options', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let requestUrl = '';
    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });
    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    try {
      expect(() =>
        stream.updateOptions({ commitStrategy: 'turn_prediction', serverVad: {} }),
      ).toThrow('turn_prediction is only supported for scribe_v3_live');
      await waitUntil(() => requestUrl !== '');
      const url = new URL(`ws://localhost${requestUrl}`);
      expect(url.searchParams.get('commit_strategy')).toBe('manual');
      expect(url.searchParams.has('vad_threshold')).toBe(false);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('finishes local VAD cleanup before reconnecting', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const vad = new TestVAD();
    let connections = 0;
    wss.on('connection', () => {
      connections += 1;
    });
    const instance = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v3_live',
      commitStrategy: 'turn_prediction',
      vad,
    });
    const stream = instance.stream();
    try {
      await waitUntil(() => vad.streams.length === 1);
      const vadStream = vad.streams[0]!;
      const originalClose = vadStream.close.bind(vadStream);
      let cleanupStarted = false;
      let cleanupDone = false;
      let allowCleanup: (() => void) | undefined;
      vadStream.close = (() => {
        cleanupStarted = true;
        return new Promise<void>((resolve) => {
          allowCleanup = () => {
            originalClose();
            cleanupDone = true;
            resolve();
          };
        });
      }) as unknown as () => void;
      instance.updateOptions({ keyterms: ['LiveKit'] });
      await waitUntil(() => cleanupStarted);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(connections).toBe(1);
      allowCleanup?.();
      await waitUntil(() => connections === 2);
      expect(cleanupDone).toBe(true);
      expect(vadStream.closeCalls).toBe(1);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('does not let an open local VAD output hold clean stream termination open', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    // Like Silero, the base VADStream.endInput() leaves the VAD output iterator open.
    const vad = new TestVAD();
    wss.on('connection', (ws) => {
      ws.once('message', () => setTimeout(() => ws.close(), 20));
    });
    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v3_live',
      commitStrategy: 'turn_prediction',
      vad,
    }).stream();
    try {
      stream.pushFrame(makeFrame());
      await waitUntil(() => vad.streams.length === 1);
      stream.endInput();
      const completed = (async () => {
        for await (const _event of stream) {
          // No transcript is expected; completion is the behavior under test.
        }
      })();
      const terminated = await Promise.race([
        completed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      expect(terminated).toBe(true);
      expect(vad.streams[0]?.closeCalls).toBe(1);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('detaches the old socket before delayed VAD cleanup on reconnect', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const vad = new TestVAD();
    const sockets: WebSocket[] = [];
    wss.on('connection', (ws) => {
      sockets.push(ws);
    });
    const instance = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v3_live',
      commitStrategy: 'turn_prediction',
      vad,
      languageCode: 'en',
      includeLanguageDetection: false,
    });
    const stream = instance.stream();
    let allowCleanup: (() => void) | undefined;
    try {
      await waitUntil(() => vad.streams.length === 1 && sockets.length === 1);
      const vadStream = vad.streams[0]!;
      const originalClose = vadStream.close.bind(vadStream);
      let cleanupStarted = false;
      vadStream.close = (() => {
        cleanupStarted = true;
        return new Promise<void>((resolve) => {
          allowCleanup = () => {
            originalClose();
            resolve();
          };
        });
      }) as unknown as () => void;
      const eventsPromise = collectUntilEnd(stream);
      instance.updateOptions({ keyterms: ['LiveKit'] });
      await waitUntil(() => cleanupStarted);

      sockets[0]!.send(JSON.stringify(partialTranscript('late old connection')));
      sockets[0]!.send(JSON.stringify(committedTranscript('late old connection')));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const releaseCleanup = allowCleanup;
      allowCleanup = undefined;
      expect(releaseCleanup).toBeDefined();
      releaseCleanup!();
      await waitUntil(() => sockets.length === 2);
      sockets[1]!.send(JSON.stringify(partialTranscript('new connection')));
      sockets[1]!.send(JSON.stringify(committedTranscript('new connection')));

      const events = await eventsPromise;
      expect(events.map((event) => event.type)).toEqual([
        sttLib.SpeechEventType.START_OF_SPEECH,
        sttLib.SpeechEventType.INTERIM_TRANSCRIPT,
        sttLib.SpeechEventType.FINAL_TRANSCRIPT,
        sttLib.SpeechEventType.END_OF_SPEECH,
      ]);
      expect(interimTexts(events)).toEqual(['new connection']);
      expect(events.at(-2)?.alternatives?.[0]?.text).toBe('new connection');
    } finally {
      allowCleanup?.();
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('reconnects after a provider error frame', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let connections = 0;
    wss.on('connection', (ws) => {
      connections += 1;
      if (connections === 1) {
        ws.once('message', () =>
          ws.send(JSON.stringify({ message_type: 'transcriber_error', message: 'retry' })),
        );
      }
    });
    const stream = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v3_live' }).stream({
      connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    try {
      stream.pushFrame(makeFrame());
      await waitUntil(() => connections === 2, 2000);
      expect(stream._failed).toBe(false);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('logs malformed messages and continues receiving transcripts', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const error = vi.spyOn(log(), 'error').mockImplementation(() => undefined);
    wss.on('connection', (ws) => {
      ws.once('message', () => {
        ws.send('{not json');
        ws.send(JSON.stringify(partialTranscript('hello')));
        ws.send(JSON.stringify(committedTranscript('hello')));
      });
    });
    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
      serverVad: {},
      includeLanguageDetection: false,
    }).stream();
    try {
      stream.pushFrame(makeFrame());
      const events = await collectUntilEnd(stream);
      expect(events.at(-1)?.type).toBe(sttLib.SpeechEventType.END_OF_SPEECH);
      expect(events.at(-2)?.alternatives?.[0]?.text).toBe('hello');
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'failed to process ElevenLabs STT message',
      );
      expect(stream._failed).toBe(false);
    } finally {
      stream.close();
      error.mockRestore();
      await closeWebSocketServer(wss);
    }
  });

  it.each([
    ['auth_error', false],
    ['quota_exceeded', false],
    ['input_error', false],
    ['transcriber_error', true],
    ['error', true],
  ] as const)(
    'keeps %s provider content in PII fields and sets retryable=%s',
    async (messageType, retryable) => {
      const { wss, baseURL } = await startWebSocketServer();
      const logged = vi.spyOn(log(), 'error').mockImplementation(() => undefined);
      wss.on('connection', (ws) => {
        ws.once('message', () =>
          ws.send(
            JSON.stringify({
              message_type: messageType,
              message: 'customer transcript',
              details: 'provider credential',
            }),
          ),
        );
      });
      const instance = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v2_realtime' });
      const emitted = new Promise<Error>((resolve) =>
        instance.once('error', (event) => resolve(event.error)),
      );
      const stream = instance.stream({
        connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
      });
      try {
        stream.pushFrame(makeFrame());
        const providerError = await emitted;
        expect(providerError).toMatchObject({
          message: `ElevenLabs STT error [${messageType}]`,
          retryable,
        });
        const providerLog = logged.mock.calls.find(
          (call) => call[1] === `ElevenLabs STT error [${messageType}]`,
        );
        expect(providerLog?.[0]).toEqual({
          'lk.pii.data': expect.objectContaining({
            message: 'customer transcript',
            details: 'provider credential',
          }),
        });
        expect(providerLog?.[1]).not.toContain('customer transcript');
        expect(providerLog?.[1]).not.toContain('provider credential');
      } finally {
        stream.close();
        logged.mockRestore();
        await closeWebSocketServer(wss);
      }
    },
  );

  it.each([
    ['options', undefined],
    ['options', 'beforeFinal'],
    ['options', 'afterFinal'],
    ['providerError', undefined],
    ['providerError', 'beforeFinal'],
    ['providerError', 'afterFinal'],
  ] as const)(
    'finishes a deferred turn before %s reconnect with continuation=%s',
    async (reconnectCause, continuation) => {
      const { wss, baseURL } = await startWebSocketServer();
      const sockets: WebSocket[] = [];
      wss.on('connection', (ws) => {
        sockets.push(ws);
        if (sockets.length !== 1) return;
        ws.once('message', () => {
          ws.send(JSON.stringify({ ...partialTranscript('hello'), turn_probability: 0 }));
          ws.send(JSON.stringify(committedTranscript('hello')));
          if (continuation === 'beforeFinal') {
            ws.send(JSON.stringify(partialTranscript('continuing')));
          }
          ws.send(
            JSON.stringify(
              committedTranscript('hello', {
                withTimestamps: true,
                words: [{ text: 'hello', start: 0.1, end: 0.4 }],
              }),
            ),
          );
        });
      });
      const instance = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v3_live',
        commitStrategy: 'turn_prediction',
        vad: new StuckSpeakingVAD(),
        languageCode: 'en',
        includeTimestamps: true,
        includeLanguageDetection: false,
        audioChunkDuration: 35300,
      });
      const stream = instance.stream({
        connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
      });
      try {
        stream.pushFrame(makeFrame(564800));
        const initialEvents: sttLib.SpeechEvent[] = [];
        const expected = continuation === 'beforeFinal' ? 4 : 3;
        while (initialEvents.length < expected) initialEvents.push((await stream.next()).value!);
        expect(initialEvents.at(-1)?.type).toBe(sttLib.SpeechEventType.FINAL_TRANSCRIPT);
        if (continuation === 'afterFinal') {
          sockets[0]!.send(JSON.stringify(partialTranscript('continuing')));
          expect((await stream.next()).value?.type).toBe(sttLib.SpeechEventType.INTERIM_TRANSCRIPT);
        }

        if (reconnectCause === 'options') instance.updateOptions({ keyterms: ['LiveKit'] });
        else {
          sockets[0]!.send(
            JSON.stringify({ message_type: 'transcriber_error', message: 'provider content' }),
          );
        }

        const endpoint = (await stream.next()).value;
        expect(endpoint?.type).toBe(sttLib.SpeechEventType.END_OF_SPEECH);
        expect(endpoint?.alternatives?.[0]?.text).toBe('hello');
        await waitUntil(() => sockets.length === 2, 2000);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(stream._failed).toBe(false);
      } finally {
        stream.close();
        await closeWebSocketServer(wss);
      }
    },
  );

  it.each([
    ['options', false],
    ['providerError', false],
    ['options', true],
  ] as const)(
    'keeps turn boundaries balanced on %s reconnect with the old final delivered=%s',
    async (reconnectCause, finalDelivered) => {
      const { wss, baseURL } = await startWebSocketServer();
      const sockets: WebSocket[] = [];
      wss.on('connection', (socket) => {
        sockets.push(socket);
        const firstConnection = sockets.length === 1;
        socket.once('message', () => {
          if (!firstConnection) {
            socket.send(JSON.stringify(partialTranscript('new partial')));
            return;
          }
          socket.send(JSON.stringify(partialTranscript('old partial')));
          socket.send(JSON.stringify(committedTranscript('old partial')));
          if (finalDelivered) {
            socket.send(
              JSON.stringify(committedTranscript('old partial', { withTimestamps: true })),
            );
          } else {
            // The repeated text is emitted only once the plain commit resets partial deduplication.
            socket.send(JSON.stringify(partialTranscript('old partial')));
          }
        });
      });
      const instance = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v3_live',
        commitStrategy: 'turn_prediction',
        vad: new TestVAD(),
        serverVad: { vadSilenceThresholdSecs: 0.5 },
        includeTimestamps: true,
        includeLanguageDetection: false,
      });
      const stream = instance.stream({
        connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
      });
      const { events } = collectAllEvents(stream);
      const { START_OF_SPEECH, INTERIM_TRANSCRIPT, FINAL_TRANSCRIPT, END_OF_SPEECH } =
        sttLib.SpeechEventType;
      try {
        stream.pushFrame(makeFrame());
        await waitUntil(() =>
          finalDelivered
            ? events.some((event) => event.type === END_OF_SPEECH)
            : events.length === 3,
        );
        if (reconnectCause === 'options') instance.updateOptions({ keyterms: ['LiveKit'] });
        else
          sockets[0]!.send(JSON.stringify({ message_type: 'transcriber_error', message: 'retry' }));

        await waitUntil(() => sockets.length === 2, 2000);
        expect(turnEvents(events).map((event) => event.type)).toEqual([
          START_OF_SPEECH,
          ...(finalDelivered ? [FINAL_TRANSCRIPT] : []),
          END_OF_SPEECH,
        ]);

        const beforeNewPartial = events.length;
        stream.pushFrame(makeFrame());
        await waitUntil(
          () => events.slice(beforeNewPartial).some((event) => event.type === END_OF_SPEECH),
          2000,
        );
        expect(events.slice(beforeNewPartial).map((event) => event.type)).toEqual([
          START_OF_SPEECH,
          INTERIM_TRANSCRIPT,
          END_OF_SPEECH,
        ]);
      } finally {
        stream.close();
        await closeWebSocketServer(wss);
      }
    },
  );

  it.each([
    ['strategy', 'frame'],
    ['strategy', 'flush'],
    ['providerError', 'frame'],
    ['providerError', 'flush'],
  ] as const)(
    'sends the first %s-reconnect input (%s) on the replacement socket',
    async (reconnectCause, input) => {
      const { wss, baseURL } = await startWebSocketServer();
      const received: { connection: number; bytes: number; commit: boolean }[] = [];
      let connections = 0;
      wss.on('connection', (ws) => {
        const connection = ++connections;
        ws.on('message', (raw) => {
          const message = JSON.parse(raw.toString());
          received.push({
            connection,
            bytes: Buffer.from(message.audio_base_64, 'base64').length,
            commit: message.commit,
          });
        });
        if (reconnectCause === 'providerError' && connection === 1) {
          // Let the idle sender start waiting for input before the provider fails.
          setTimeout(
            () => ws.send(JSON.stringify({ message_type: 'transcriber_error', message: 'retry' })),
            20,
          );
        }
      });
      const instance = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v3_live',
        commitStrategy: 'vad',
      });
      const stream = instance.stream({
        connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
      });
      try {
        await waitUntil(() => connections === 1);
        if (reconnectCause === 'strategy') {
          await new Promise((resolve) => setTimeout(resolve, 20));
          instance.updateOptions({ commitStrategy: 'manual' });
        }
        await waitUntil(() => connections === 2);
        await new Promise((resolve) => setTimeout(resolve, 20));

        if (input === 'frame') stream.pushFrame(makeFrame(800));
        else stream.flush();
        const expected =
          input === 'frame'
            ? [{ connection: 2, bytes: 1600, commit: false }]
            : [
                { connection: 2, bytes: MIN_COMMIT_SAMPLES * 2, commit: false },
                { connection: 2, bytes: 0, commit: true },
              ];
        await waitUntil(() => received.length >= expected.length);
        expect(received).toEqual(expected);
        expect(stream._failed).toBe(false);
      } finally {
        stream.close();
        await closeWebSocketServer(wss);
      }
    },
  );

  it('closes local VAD and the socket when the stream closes during a deferred turn', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const vad = new (class extends TestVAD {
      override stream(): TestVADStream {
        const stream = super.stream();
        stream.emit(VADEventType.START_OF_SPEECH);
        return stream;
      }
    })();
    const sockets: WebSocket[] = [];
    wss.on('connection', (ws) => {
      sockets.push(ws);
      ws.once('message', () => {
        ws.send(JSON.stringify({ ...partialTranscript('hello'), turn_probability: 0 }));
        ws.send(JSON.stringify(committedTranscript('hello')));
      });
    });
    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v3_live',
      commitStrategy: 'turn_prediction',
      vad,
      languageCode: 'en',
      includeLanguageDetection: false,
      audioChunkDuration: 35300,
    }).stream({ connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 } });
    try {
      stream.pushFrame(makeFrame(564800));
      const events: sttLib.SpeechEvent[] = [];
      while (events.at(-1)?.type !== sttLib.SpeechEventType.FINAL_TRANSCRIPT) {
        events.push((await stream.next()).value!);
      }
      // The forced commit defers end of speech, so close() must finish the turn itself.
      expect(events.map((event) => event.type)).not.toContain(sttLib.SpeechEventType.END_OF_SPEECH);

      stream.close();
      await waitUntil(() => sockets[0]?.readyState === sockets[0]?.CLOSED);
      expect(vad.streams[0]?.closeCalls).toBe(1);
    } finally {
      stream.close();
      sockets.forEach((socket) => socket.terminate());
      await closeWebSocketServer(wss);
    }
  });

  describe('uncommitted partial timeout', () => {
    let vad: TestVAD;
    let ended: Mock<() => void>;
    let detector: TurnDetection;
    let vadTask: Promise<void>;

    beforeEach(async () => {
      vi.useFakeTimers();
      vad = new TestVAD();
      ended = vi.fn<() => void>();
      detector = new TurnDetection({
        options: {
          modelId: 'scribe_v3_live',
          commitStrategy: 'turn_prediction',
          serverVad: { vadSilenceThresholdSecs: 0.5 },
        },
        vad,
        onEndOfSpeech: ended,
      });
      await detector.start();
      vadTask = detector.runVad();
    });

    afterEach(async () => {
      await detector.close();
      await vadTask;
      vi.useRealTimers();
    });

    it.each([false, true])(
      'ignores an existing-turn partial with VAD initially speaking=%s',
      async (speaking) => {
        if (speaking) {
          vad.streams[0]!.emit(VADEventType.START_OF_SPEECH);
          await vi.advanceTimersByTimeAsync(0);
        }
        detector.onPartialTranscript(0.5, 'continuation', false);
        if (speaking) vad.streams[0]!.emit(VADEventType.END_OF_SPEECH);
        await vi.advanceTimersByTimeAsync(3000);
        expect(ended).not.toHaveBeenCalled();
      },
    );

    it('ends an uncommitted partial once without extending the deadline for duplicates', async () => {
      detector.onPartialTranscript(0.76, 'Yeah.', true);
      await vi.advanceTimersByTimeAsync(700);
      expect(detector.onPartialTranscript(0.8, 'Yeah.')).toBe(false);
      await vi.advanceTimersByTimeAsync(299);
      expect(ended).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toHaveBeenCalledTimes(1);
      detector.onPartialTranscript(0.8, 'Yeah.');
      await vi.advanceTimersByTimeAsync(2000);
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it('does not extend the deadline for changed partial text without VAD speech', async () => {
      detector.onPartialTranscript(0.5, 'Hello', true);
      await vi.advanceTimersByTimeAsync(700);
      detector.onPartialTranscript(0.5, 'Hello there');
      await vi.advanceTimersByTimeAsync(299);
      expect(ended).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it('requires a full quiet window after local VAD speech', async () => {
      detector.onPartialTranscript(0.5, 'Hello', true);
      await vi.advanceTimersByTimeAsync(700);
      vad.streams[0]!.emit(VADEventType.START_OF_SPEECH);
      await vi.advanceTimersByTimeAsync(2000);
      expect(ended).not.toHaveBeenCalled();
      detector.onPartialTranscript(0.5, 'Hello there');
      await vi.advanceTimersByTimeAsync(2000);
      expect(ended).not.toHaveBeenCalled();
      vad.streams[0]!.emit(VADEventType.END_OF_SPEECH);
      await vi.advanceTimersByTimeAsync(999);
      expect(ended).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it.each(['Hello', ''])('cancels the timeout when the provider commits %j', async (text) => {
      detector.onPartialTranscript(0.5, 'Hello', true);
      await vi.advanceTimersByTimeAsync(700);
      detector.onCommittedTranscript(
        { message_type: 'committed_transcript', text },
        'committed_transcript_with_timestamps',
      );
      // The provider has committed even if its selected timestamp copy has not arrived yet.
      await vi.advanceTimersByTimeAsync(2000);
      expect(ended).not.toHaveBeenCalled();
      detector.onCommittedTranscript(
        { message_type: 'committed_transcript_with_timestamps', text },
        'committed_transcript_with_timestamps',
      );
      detector.endSpeech();
      await vi.advanceTimersByTimeAsync(2000);
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it('does not enable a continuation timeout when a forced timestamp copy arrives late', async () => {
      detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
      detector.onPartialTranscript(0.5, 'Old segment', true);
      detector.onCommittedTranscript(
        { message_type: 'committed_transcript', text: 'Old segment' },
        'committed_transcript_with_timestamps',
      );
      vad.streams[0]!.emit(VADEventType.END_OF_SPEECH);
      await vi.advanceTimersByTimeAsync(0);
      detector.onPartialTranscript(0.5, 'New segment');
      await vi.advanceTimersByTimeAsync(700);
      expect(
        detector.onCommittedTranscript(
          { message_type: 'committed_transcript_with_timestamps', text: 'Old segment' },
          'committed_transcript_with_timestamps',
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(ended).not.toHaveBeenCalled();
    });

    it('ignores an unselected timestamp copy while a newer partial is pending', async () => {
      detector.onPartialTranscript(0.5, 'Old segment', true);
      detector.onCommittedTranscript(
        { message_type: 'committed_transcript', text: 'Old segment' },
        'committed_transcript',
      );
      detector.endSpeech();
      detector.onPartialTranscript(0.5, 'New segment', true);
      detector.onCommittedTranscript(
        { message_type: 'committed_transcript_with_timestamps', text: 'Old segment' },
        'committed_transcript',
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(ended).toHaveBeenCalledTimes(2);
    });

    it('guards a fresh partial turn after the forced-commit fallback ends the previous turn', async () => {
      detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
      detector.onPartialTranscript(0.5, 'Old segment', true);
      detector.onCommittedTranscript(
        { message_type: 'committed_transcript', text: 'Old segment' },
        'committed_transcript_with_timestamps',
      );
      expect(
        detector.onCommittedTranscript(
          { message_type: 'committed_transcript_with_timestamps', text: 'Old segment' },
          'committed_transcript_with_timestamps',
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ended).toHaveBeenCalledTimes(1);
      detector.onPartialTranscript(0.5, 'Fresh turn', true);
      vad.streams[0]!.emit(VADEventType.END_OF_SPEECH);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ended).toHaveBeenCalledTimes(2);
    });

    it.each(['close', 'restart'] as const)(
      'cancels the old connection timeout on %s',
      async (action) => {
        detector.onPartialTranscript(0.5, 'Old connection', true);
        await vi.advanceTimersByTimeAsync(700);
        if (action === 'restart') await detector.start();
        else await detector.close();
        expect(ended).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(ended).toHaveBeenCalledTimes(1);
        if (action === 'restart') {
          detector.onPartialTranscript(0.5, 'New connection', true);
          await vi.advanceTimersByTimeAsync(1000);
          expect(ended).toHaveBeenCalledTimes(2);
        }
      },
    );

    it('cancels the timeout if local VAD fails', async () => {
      detector.onPartialTranscript(0.5, 'Hello', true);
      vi.spyOn(vad.streams[0]!, 'pushFrame').mockImplementation(() => {
        throw new Error('VAD failed');
      });
      await detector.pushFrame(makeFrame());
      await vi.advanceTimersByTimeAsync(2000);
      expect(ended).not.toHaveBeenCalled();
      detector.onPartialTranscript(0.5, 'Hello there');
      await vi.advanceTimersByTimeAsync(2000);
      expect(ended).not.toHaveBeenCalled();
    });

    it.each([
      ['scribe_v3_live', 'manual', true],
      ['scribe_v2_realtime', 'vad', true],
      ['scribe_v3_live', 'turn_prediction', false],
    ] as const)(
      'stays disabled for model=%s strategy=%s localVAD=%s',
      async (modelId, commitStrategy, localVAD) => {
        const other = new TurnDetection({
          options: { modelId, commitStrategy },
          vad: localVAD ? new TestVAD() : undefined,
          onEndOfSpeech: ended,
        });
        try {
          await other.start();
          other.onPartialTranscript(0.5, 'Hello', true);
          await vi.advanceTimersByTimeAsync(10000);
          expect(ended).not.toHaveBeenCalled();
        } finally {
          await other.close();
        }
      },
    );
  });

  it.each([false, true])(
    'closes a dangling partial after an earlier committed turn=%s',
    async (afterCommit) => {
      const { wss, baseURL } = await startWebSocketServer();
      const connected = once(wss, 'connection');
      const stream = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v3_live',
        commitStrategy: 'turn_prediction',
        vad: new TestVAD(),
        serverVad: { vadSilenceThresholdSecs: 0.5 },
        includeLanguageDetection: false,
      }).stream();
      const { events } = collectAllEvents(stream);
      try {
        const [socket] = (await connected) as [WebSocket];
        const audioReceived = once(socket, 'message');
        stream.pushFrame(makeFrame());
        await audioReceived;
        if (afterCommit) {
          socket.send(JSON.stringify(committedTranscript('Tell me a story.')));
          await waitUntil(() =>
            events.some((event) => event.type === sttLib.SpeechEventType.END_OF_SPEECH),
          );
          events.length = 0;
        }
        socket.send(JSON.stringify(partialTranscript('Yeah.')));
        await waitUntil(() =>
          events.some((event) => event.type === sttLib.SpeechEventType.INTERIM_TRANSCRIPT),
        );
        await waitUntil(
          () => events.some((event) => event.type === sttLib.SpeechEventType.END_OF_SPEECH),
          2000,
        );
        expect(events.map((event) => event.type)).toEqual([
          sttLib.SpeechEventType.START_OF_SPEECH,
          sttLib.SpeechEventType.INTERIM_TRANSCRIPT,
          sttLib.SpeechEventType.END_OF_SPEECH,
        ]);
        expect(events.at(-1)?.alternatives).toBeUndefined();
        socket.send(JSON.stringify(committedTranscript('')));
        socket.send(JSON.stringify(committedTranscript('Next real turn')));
        await waitUntil(() => finalTexts(events).length === 1);
        expect(turnEvents(events).map((event) => event.type)).toEqual([
          sttLib.SpeechEventType.START_OF_SPEECH,
          sttLib.SpeechEventType.END_OF_SPEECH,
          sttLib.SpeechEventType.START_OF_SPEECH,
          sttLib.SpeechEventType.FINAL_TRANSCRIPT,
          sttLib.SpeechEventType.END_OF_SPEECH,
        ]);
      } finally {
        stream.close();
        for (const socket of wss.clients) socket.terminate();
        await closeWebSocketServer(wss);
      }
    },
  );

  it.each([false, true])(
    'does not time out a mid-turn continuation after a forced commit with timestamps=%s',
    async (includeTimestamps) => {
      const { wss, baseURL } = await startWebSocketServer();
      const connected = once(wss, 'connection');
      const vad = new (class extends TestVAD {
        override stream(): TestVADStream {
          const stream = super.stream();
          stream.emit(VADEventType.START_OF_SPEECH);
          return stream;
        }
      })();
      const stream = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v3_live',
        commitStrategy: 'turn_prediction',
        vad,
        includeTimestamps,
        includeLanguageDetection: false,
        audioChunkDuration: 35300,
        serverVad: { vadSilenceThresholdSecs: 0.5 },
      }).stream();
      const { events } = collectAllEvents(stream);
      try {
        const [socket] = (await connected) as [WebSocket];
        const audioReceived = once(socket, 'message');
        stream.pushFrame(makeFrame(564800));
        await audioReceived;
        socket.send(JSON.stringify({ ...partialTranscript('old segment'), turn_probability: 0.5 }));
        socket.send(JSON.stringify(committedTranscript('old segment')));
        if (includeTimestamps) {
          socket.send(JSON.stringify(committedTranscript('old segment', { withTimestamps: true })));
        }
        await waitUntil(() => finalTexts(events).length === 1);
        socket.send(JSON.stringify(partialTranscript('continuation')));
        await waitUntil(() => interimTexts(events).includes('continuation'));
        vad.streams[0]!.emit(VADEventType.END_OF_SPEECH);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(
          events.filter((event) => event.type === sttLib.SpeechEventType.START_OF_SPEECH),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.type === sttLib.SpeechEventType.END_OF_SPEECH),
        ).toHaveLength(0);
        socket.send(JSON.stringify(committedTranscript('continuation')));
        if (includeTimestamps) {
          socket.send(
            JSON.stringify(committedTranscript('continuation', { withTimestamps: true })),
          );
        }
        await waitUntil(() =>
          events.some((event) => event.type === sttLib.SpeechEventType.END_OF_SPEECH),
        );
        expect(finalTexts(events)).toEqual(['old segment', 'continuation']);
      } finally {
        stream.close();
        for (const socket of wss.clients) socket.terminate();
        await closeWebSocketServer(wss);
      }
    },
  );

  describe('turn prediction forced-commit guard', () => {
    it('defers a suspected forced commit and falls back once', async () => {
      vi.useFakeTimers();
      const ended = vi.fn();
      const detector = new TurnDetection({
        options: {
          modelId: 'scribe_v3_live',
          commitStrategy: 'turn_prediction',
          serverVad: { vadSilenceThresholdSecs: 0.5 },
        },
        onEndOfSpeech: ended,
      });
      detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
      detector.onPartialTranscript(0, 'still speaking');
      expect(
        detector.onCommittedTranscript(
          { message_type: 'committed_transcript', text: 'still speaking' },
          'committed_transcript',
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(999);
      expect(ended).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toHaveBeenCalledTimes(1);
      await detector.close();
      expect(ended).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('cancels the fallback when a continuation segment arrives', async () => {
      vi.useFakeTimers();
      const ended = vi.fn();
      const detector = new TurnDetection({
        options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
        onEndOfSpeech: ended,
      });
      detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
      detector.onPartialTranscript(0, 'still speaking');
      detector.onCommittedTranscript(
        { message_type: 'committed_transcript', text: 'still speaking' },
        'committed_transcript',
      );
      detector.onPartialTranscript(0.1, 'and continuing');
      await vi.advanceTimersByTimeAsync(5000);
      expect(ended).not.toHaveBeenCalled();
      detector.endSpeech();
      expect(ended).toHaveBeenCalledTimes(1);
      await detector.close();
      vi.useRealTimers();
    });

    it.each([0.9, 1])(
      'updates turn probability to %s when duplicate partial text is suppressed',
      async (probability) => {
        const ended = vi.fn();
        const detector = new TurnDetection({
          options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
          onEndOfSpeech: ended,
        });
        detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
        expect(detector.onPartialTranscript(0, 'still speaking')).toBe(true);
        expect(detector.onPartialTranscript(probability, 'still speaking')).toBe(false);
        expect(
          detector.onCommittedTranscript(
            { message_type: 'committed_transcript', text: 'still speaking' },
            'committed_transcript',
          ),
        ).toBe(false);
        await detector.close();
      },
    );

    it.each([
      [10, 0, true, 0],
      [40, 0, true, 0],
      [35.3, 0.9, true, 0],
      [35.3, undefined, true, 0],
      [35.3, 0, false, 0],
      [35.3, 0, true, 1],
    ] as const)(
      'does not classify duration=%s probability=%s speaking=%s commits=%s as forced',
      async (duration, probability, speaking, clientCommits) => {
        const ended = vi.fn();
        const detector = new TurnDetection({
          options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
          onEndOfSpeech: ended,
        });
        detector._setClassifierState({
          vadSpeaking: speaking,
          audioDurationSinceCommitInS: duration,
        });
        detector.onPartialTranscript(probability, 'still speaking');
        for (let index = 0; index < clientCommits; index++) detector.onCommitRequested();
        const forced = detector.onCommittedTranscript(
          { message_type: 'committed_transcript', text: 'hello' },
          'committed_transcript',
        );
        expect(forced).toBe(false);
        if (!forced) detector.endSpeech();
        expect(ended).toHaveBeenCalledTimes(1);
        await detector.close();
      },
    );

    it.each([
      [null, 2000],
      [0.5, 1000],
    ] as const)(
      'uses the %s silence threshold timeout and keeps logs PII-free',
      async (silenceThreshold, timeout) => {
        vi.useFakeTimers();
        const debug = vi.spyOn(log(), 'debug').mockImplementation(() => undefined);
        const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
        const ended = vi.fn();
        try {
          const detector = new TurnDetection({
            options: {
              modelId: 'scribe_v3_live',
              commitStrategy: 'turn_prediction',
              serverVad: { vadSilenceThresholdSecs: silenceThreshold },
            },
            onEndOfSpeech: ended,
          });
          detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
          detector.onPartialTranscript(0, 'still speaking');
          expect(
            detector.onCommittedTranscript(
              { message_type: 'committed_transcript', text: 'still speaking' },
              'committed_transcript',
            ),
          ).toBe(true);
          detector.onPartialTranscript(0, '');
          await vi.advanceTimersByTimeAsync(timeout - 1);
          expect(ended).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(ended).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(2000);
          expect(ended).toHaveBeenCalledTimes(1);
          expect(debug).toHaveBeenCalledWith(
            expect.objectContaining({
              audioDurationSinceCommitInS: 35.3,
              turnProbability: 0,
              vadSpeaking: true,
            }),
            expect.stringContaining('deferring end of speech'),
          );
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ eosTimeout: timeout, vadSpeaking: true }),
            expect.stringContaining('emitting end of speech'),
          );
          const serializedLogs = JSON.stringify([...debug.mock.calls, ...warn.mock.calls]);
          expect(serializedLogs).not.toContain('still speaking');
          expect(serializedLogs).not.toContain('lk.pii.data');
          await detector.close();
        } finally {
          debug.mockRestore();
          warn.mockRestore();
          vi.useRealTimers();
        }
      },
    );

    it('resets forced-commit duration for each segment', async () => {
      vi.useFakeTimers();
      const detector = new TurnDetection({
        options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
        onEndOfSpeech: vi.fn(),
      });
      try {
        detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
        detector.onPartialTranscript(0, 'still speaking');
        expect(
          detector.onCommittedTranscript(
            { message_type: 'committed_transcript', text: 'still speaking' },
            'committed_transcript',
          ),
        ).toBe(true);
        detector.onPartialTranscript(0, 'next segment');
        await detector.pushFrame(makeFrame(35300, 1000));
        expect(
          detector.onCommittedTranscript(
            { message_type: 'committed_transcript', text: 'next segment' },
            'committed_transcript',
          ),
        ).toBe(true);
      } finally {
        await detector.close();
        vi.useRealTimers();
      }
    });

    it('retains a forced decision across delayed timestamps and continuation-before-copy', async () => {
      vi.useFakeTimers();
      const ended = vi.fn();
      const detector = new TurnDetection({
        options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
        onEndOfSpeech: ended,
      });
      try {
        detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
        detector.onPartialTranscript(0, 'still speaking');
        expect(
          detector.onCommittedTranscript(
            { message_type: 'committed_transcript', text: 'still speaking' },
            'committed_transcript_with_timestamps',
          ),
        ).toBe(false);
        detector.onPartialTranscript(0.95, 'next segment');
        detector._setClassifierState({ vadSpeaking: false });
        expect(
          detector.onCommittedTranscript(
            { message_type: 'committed_transcript_with_timestamps', text: 'still speaking' },
            'committed_transcript_with_timestamps',
          ),
        ).toBe(true);
        await vi.advanceTimersByTimeAsync(5000);
        expect(ended).not.toHaveBeenCalled();
        detector.onCommittedTranscript(
          { message_type: 'committed_transcript', text: 'next segment' },
          'committed_transcript_with_timestamps',
        );
        const forced = detector.onCommittedTranscript(
          { message_type: 'committed_transcript_with_timestamps', text: 'next segment' },
          'committed_transcript_with_timestamps',
        );
        expect(forced).toBe(false);
        detector.endSpeech();
        expect(ended).toHaveBeenCalledTimes(1);
      } finally {
        await detector.close();
        vi.useRealTimers();
      }
    });

    it.each(['still speaking', 'next segment'])(
      'resets partial dedupe on the plain commit before delayed timestamps (%s)',
      async (continuation) => {
        const detector = new TurnDetection({
          options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
          onEndOfSpeech: vi.fn(),
        });
        detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
        expect(detector.onPartialTranscript(0, 'still speaking')).toBe(true);
        detector.onCommittedTranscript(
          { message_type: 'committed_transcript', text: 'still speaking' },
          'committed_transcript_with_timestamps',
        );
        expect(detector.onPartialTranscript(0, continuation)).toBe(true);
        detector.onCommittedTranscript(
          { message_type: 'committed_transcript_with_timestamps', text: 'still speaking' },
          'committed_transcript_with_timestamps',
        );
        expect(detector.onPartialTranscript(0, continuation)).toBe(false);
        await detector.close();
      },
    );

    it('cancels a forced-commit timer when the server sends its final boundary', async () => {
      vi.useFakeTimers();
      const ended = vi.fn();
      const detector = new TurnDetection({
        options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
        onEndOfSpeech: ended,
      });
      try {
        detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
        detector.onPartialTranscript(0, 'still speaking');
        detector.onCommittedTranscript(
          { message_type: 'committed_transcript', text: 'still speaking' },
          'committed_transcript',
        );
        const forced = detector.onCommittedTranscript(
          { message_type: 'committed_transcript', text: '' },
          'committed_transcript',
        );
        expect(forced).toBe(false);
        detector.endSpeech();
        await vi.advanceTimersByTimeAsync(5000);
        expect(ended).toHaveBeenCalledTimes(1);
      } finally {
        await detector.close();
        vi.useRealTimers();
      }
    });

    it.each([
      ['close', false],
      ['close', true],
      ['restart', false],
      ['restart', true],
    ] as const)(
      'finishes a deferred turn on %s with timestamps=%s and isolates the next turn',
      async (completion, includeTimestamps) => {
        vi.useFakeTimers();
        const ended = vi.fn();
        const detector = new TurnDetection({
          options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
          onEndOfSpeech: ended,
        });
        try {
          detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
          detector.onPartialTranscript(0, 'still speaking');
          const finalMessageType = includeTimestamps
            ? 'committed_transcript_with_timestamps'
            : 'committed_transcript';
          detector.onCommittedTranscript(
            { message_type: 'committed_transcript', text: 'still speaking' },
            finalMessageType,
          );
          if (includeTimestamps) {
            detector.onCommittedTranscript(
              { message_type: 'committed_transcript_with_timestamps', text: 'still speaking' },
              finalMessageType,
            );
          }
          if (completion === 'restart') await detector.start();
          else await detector.close();
          expect(ended).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(5000);
          expect(ended).toHaveBeenCalledTimes(1);
          if (completion === 'close') await detector.start();
          detector.onPartialTranscript(1, 'new connection');
          const forced = detector.onCommittedTranscript(
            {
              message_type: finalMessageType,
              text: 'new connection',
            },
            finalMessageType,
          );
          expect(forced).toBe(false);
          detector.endSpeech();
          expect(ended).toHaveBeenCalledTimes(2);
        } finally {
          await detector.close();
          vi.useRealTimers();
        }
      },
    );

    it.each(['serverFinal', 'timeout'])(
      'does not end a new partial when a completed deferred turn closes (%s)',
      async (completion) => {
        vi.useFakeTimers();
        const ended = vi.fn();
        const detector = new TurnDetection({
          options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
          onEndOfSpeech: ended,
        });
        try {
          detector._setClassifierState({ vadSpeaking: true, audioDurationSinceCommitInS: 35.3 });
          detector.onPartialTranscript(0, 'still speaking');
          detector.onCommittedTranscript(
            { message_type: 'committed_transcript', text: 'still speaking' },
            'committed_transcript',
          );
          if (completion === 'serverFinal') {
            detector.onCommittedTranscript(
              { message_type: 'committed_transcript', text: 'done' },
              'committed_transcript',
            );
            detector.endSpeech();
          } else {
            await vi.advanceTimersByTimeAsync(2000);
          }
          expect(ended).toHaveBeenCalledTimes(1);
          detector.onPartialTranscript(undefined, 'new turn');
          await detector.close();
          expect(ended).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('starts and closes local VAD and tolerates VAD startup failure', async () => {
      const vad = new TestVAD();
      const detector = new TurnDetection({
        options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
        vad,
        onEndOfSpeech: vi.fn(),
      });
      await detector.start();
      vad.streams[0]!.emit(VADEventType.START_OF_SPEECH);
      await detector.pushFrame(makeFrame(16000));
      await detector.close();
      expect(vad.streams[0]!.closeCalls).toBe(1);

      const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
      const failing = new TurnDetection({
        options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
        vad: new TestVAD(true),
        onEndOfSpeech: vi.fn(),
      });
      await expect(failing.start()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        expect.stringContaining('disabling forced-commit guard'),
      );
      warn.mockRestore();
    });

    it('ends real VAD input after forwarded frames without an unhandled rejection', async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      const vad = new TestVAD();
      const detector = new TurnDetection({
        options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
        vad,
        onEndOfSpeech: vi.fn(),
      });
      try {
        await detector.start();
        const frames = [makeFrame(160), makeFrame(320)];
        for (const frame of frames) await detector.pushFrame(frame);
        await detector.endInput();
        const input = await Promise.race([
          vad.streams[0]!.readInput(),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        expect(input).toEqual(frames);
        expect(rejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
        await detector.close();
      }
    });

    it.each(['pushFrame', 'inference', 'endInput'] as const)(
      'disables local VAD after a %s failure without failing turn detection',
      async (failurePoint) => {
        class FailingStream extends TestVADStream {
          override pushFrame(frame: AudioFrame): void {
            if (failurePoint === 'pushFrame') throw new Error('VAD push failed');
            super.pushFrame(frame);
          }

          override endInput(): void {
            if (failurePoint === 'endInput') throw new Error('VAD end input failed');
            super.endInput();
          }

          override next(): Promise<IteratorResult<VADEvent>> {
            if (failurePoint === 'inference') return Promise.reject(new Error('VAD failed'));
            return super.next();
          }
        }

        class FailingVAD extends VAD {
          label = 'test.FailingVAD';
          streamInstance?: FailingStream;

          constructor() {
            super({ updateInterval: 100 });
          }

          stream(): VADStream {
            this.streamInstance = new FailingStream(this);
            return this.streamInstance;
          }
        }

        const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
        const vad = new FailingVAD();
        const detector = new TurnDetection({
          options: { modelId: 'scribe_v3_live', commitStrategy: 'turn_prediction' },
          vad,
          onEndOfSpeech: vi.fn(),
        });
        await detector.start();
        if (failurePoint === 'pushFrame') await detector.pushFrame(makeFrame());
        if (failurePoint === 'inference') await detector.runVad();
        if (failurePoint === 'endInput') await detector.endInput();
        await detector.pushFrame(makeFrame());
        await detector.close();
        expect(vad.streamInstance?.closeCalls).toBe(1);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.any(Error) }),
          expect.stringContaining('disabling forced-commit guard'),
        );
        warn.mockRestore();
      },
    );
  });
  it('normalizes the primary language in the realtime connection URL', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en_US',
      secondaryLanguages: ['ru-RU'],
    });

    expect(url.searchParams.getAll('language_code')).toEqual(['en']);
    expect(url.searchParams.getAll('secondary_languages')).toEqual(['ru']);
  });

  it('includes secondary languages as repeated realtime query parameters', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en',
      secondaryLanguages: ['ru', 'es'],
    });

    expect(url.searchParams.get('language_code')).toBe('en');
    expect(url.searchParams.getAll('secondary_languages')).toEqual(['ru', 'es']);
  });

  it('normalizes secondary languages in the realtime connection URL', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en',
      secondaryLanguages: ['ru_RU', 'french', 'spa'],
    });

    expect(url.searchParams.getAll('secondary_languages')).toEqual(['ru', 'fr', 'es']);
  });

  it('omits secondary languages when not given', async () => {
    const url = await realtimeConnectionUrl({ languageCode: 'en' });

    expect(url.searchParams.has('secondary_languages')).toBe(false);
  });

  it('normalizes language options before serializing them', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en_US',
      secondaryLanguages: ['ru_RU', 'french', 'spa'],
    });

    expect(url.searchParams.get('language_code')).toBe('en');
    expect(url.searchParams.getAll('secondary_languages')).toEqual(['ru', 'fr', 'es']);
  });

  it('ignores secondary languages for batch models', () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    new STT({ apiKey: 'test-key', model: 'scribe_v2', secondaryLanguages: ['ru'] });

    expect(warn).toHaveBeenCalledWith(
      '`secondaryLanguages` is only supported for realtime models and will be ignored',
    );
    warn.mockRestore();
  });

  it('requests language detection when no language is pinned', async () => {
    const url = await realtimeConnectionUrl();

    expect(url.searchParams.get('include_language_detection')).toBe('true');
  });

  it('omits language detection when a language is pinned', async () => {
    const url = await realtimeConnectionUrl({ languageCode: 'en' });

    expect(url.searchParams.has('include_language_detection')).toBe(false);
  });

  it('requests language detection when explicitly enabled', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en',
      includeLanguageDetection: true,
    });

    expect(url.searchParams.get('include_language_detection')).toBe('true');
  });

  it('omits language detection when explicitly disabled', async () => {
    const url = await realtimeConnectionUrl({ includeLanguageDetection: false });

    expect(url.searchParams.has('include_language_detection')).toBe(false);
  });

  it('reports the detected language on final transcripts', async () => {
    const events = await processStreamEvents(
      [
        committedTranscript('привет'),
        committedTranscript('привет', { withTimestamps: true, languageCode: 'ru' }),
      ],
      3,
      { vadSilenceThresholdSecs: 0.5 },
      { languageCode: 'en', secondaryLanguages: ['ru'], includeLanguageDetection: true },
    );

    const finals = events.filter((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.alternatives?.[0]?.language).toBe('ru');
  });

  it('reports autodetected languages without adding unrequested word timings', async () => {
    const events = await processStreamEvents(
      [
        committedTranscript('привет', {
          withTimestamps: true,
          languageCode: 'ru',
          words: [{ text: 'привет', start: 0.1, end: 0.4 }],
        }),
        committedTranscript('привет'),
      ],
      2,
      null,
    );

    const finals = events.filter((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.alternatives?.[0]?.language).toBe('ru');
    expect(finals[0]?.alternatives?.[0]?.words).toBeUndefined();
  });

  it('keeps the plain final transcript when detection is disabled', async () => {
    const events = await processStreamEvents(
      [committedTranscript('hola'), committedTranscript('hola', { withTimestamps: true })],
      2,
      null,
      { languageCode: 'es' },
    );

    const finals = events.filter((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.alternatives?.[0]?.language).toBe('es');
  });

  it.each([
    [{ text: 'again', start: 0.5, end: 0.8 }, 'again'],
    [{ text: 'again', start: 0, end: 0 }, undefined],
    [undefined, undefined],
  ] as const)('keeps only the latest timed final for EOS (%j)', async (lastWord, expectedText) => {
    const events = await processStreamEvents(
      [
        committedTranscript('hello', {
          withTimestamps: true,
          words: [{ text: 'hello', start: 0.1, end: 0.4 }],
        }),
        committedTranscript('again', {
          withTimestamps: true,
          words: lastWord ? [lastWord] : [],
        }),
        committedTranscript('', { withTimestamps: true }),
      ],
      4,
      null,
      { languageCode: 'en', includeTimestamps: true, includeLanguageDetection: false },
    );
    const endpoint = events.at(-1);
    expect(endpoint?.type).toBe(sttLib.SpeechEventType.END_OF_SPEECH);
    if (expectedText)
      expect(endpoint?.alternatives?.map((item) => item.text)).toEqual([expectedText]);
    else expect(endpoint?.alternatives).toBeUndefined();
  });

  describe.each([
    'partial_transcript',
    'committed_transcript',
    'committed_transcript_with_timestamps',
  ] as const)('%s language', (messageType) => {
    it.each([
      ['es', {}, 'es'],
      ['es', { language_code: null }, 'es'],
      ['es', { language_code: '' }, 'es'],
      ['es', { language_code: 'fra' }, 'fr'],
      [undefined, {}, 'en'],
      [undefined, { language_code: null }, 'en'],
      [undefined, { language_code: '' }, 'en'],
      [undefined, { language_code: 'fra' }, 'fr'],
    ] as const)(
      'falls back from $1 with configured language $0 to $2',
      async (languageCode, languageData, expectedLanguage) => {
        const events = await processStreamEvents(
          [{ message_type: messageType, text: 'hola', ...languageData }],
          2,
          null,
          {
            languageCode,
            includeTimestamps: messageType === 'committed_transcript_with_timestamps',
            includeLanguageDetection: false,
          },
        );

        const transcript = events.at(-1);
        expect(transcript?.type).toBe(
          messageType === 'partial_transcript'
            ? sttLib.SpeechEventType.INTERIM_TRANSCRIPT
            : sttLib.SpeechEventType.FINAL_TRANSCRIPT,
        );
        expect(transcript?.alternatives?.[0]?.language).toBe(expectedLanguage);
      },
    );
  });

  it('forwards advancing partial transcripts', async () => {
    const events = await processStreamEvents(
      [partialTranscript('yeah'), partialTranscript('yeah please')],
      3,
      { vadSilenceThresholdSecs: 0.5 },
    );

    expect(interimTexts(events)).toEqual(['yeah', 'yeah please']);
  });

  it('drops re-sent partial transcripts', async () => {
    const events = await processStreamEvents(
      Array.from({ length: 5 }, () => partialTranscript('yeah please')),
      2,
      { vadSilenceThresholdSecs: 0.5 },
    );

    expect(interimTexts(events)).toEqual(['yeah please']);
    expect(events.map((event) => event.type)).toEqual([
      sttLib.SpeechEventType.START_OF_SPEECH,
      sttLib.SpeechEventType.INTERIM_TRANSCRIPT,
    ]);
  });

  it('forwards the same words again after a commit', async () => {
    const events = await processStreamEvents(
      [partialTranscript('right'), committedTranscript('right'), partialTranscript('right')],
      6,
      { vadSilenceThresholdSecs: 0.5 },
      { includeLanguageDetection: false },
    );

    expect(interimTexts(events)).toEqual(['right', 'right']);
  });

  it('forwards the same words again after an empty commit', async () => {
    const events = await processStreamEvents(
      [partialTranscript('right'), committedTranscript(''), partialTranscript('right')],
      5,
      null,
      { includeLanguageDetection: false },
    );

    expect(interimTexts(events)).toEqual(['right', 'right']);
  });

  it('calculates confidence from spoken-word logprobs', async () => {
    const event = await recognizeWords([
      { type: 'word', logprob: -0.01 },
      { type: 'spacing', logprob: -2 },
      { type: 'word', logprob: -0.05 },
    ]);

    expect(event.alternatives?.[0]?.confidence).toBeGreaterThan(0.9);
    expect(event.alternatives?.[0]?.confidence).toBeLessThanOrEqual(1);
  });

  it('flags low-quality transcription confidence', async () => {
    const event = await recognizeWords([
      { type: 'word', logprob: -2.5 },
      { type: 'word', logprob: -3 },
    ]);

    expect(event.alternatives?.[0]?.confidence).toBeLessThan(0.2);
  });

  it('defaults confidence to zero without logprobs', async () => {
    const withoutWords = await recognizeWords();
    const withoutLogprobs = await recognizeWords([{ text: 'hi', start: 0.1, end: 0.4 }]);

    expect(withoutWords.alternatives?.[0]?.confidence).toBe(0);
    expect(withoutLogprobs.alternatives?.[0]?.confidence).toBe(0);
  });

  it('sets confidence on committed transcripts', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let connected = false;

    wss.on('connection', (ws) => {
      connected = true;
      ws.on('message', () => {
        ws.send(
          JSON.stringify({
            message_type: 'committed_transcript',
            text: 'hello',
            words: [{ text: 'hello', start: 0.1, end: 0.4, type: 'word', logprob: -0.02 }],
          }),
        );
        ws.send(JSON.stringify({ message_type: 'committed_transcript', text: '' }));
      });
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v2_realtime',
        serverVad: { vadSilenceThresholdSecs: 0.5 },
        includeLanguageDetection: false,
      }).stream();
      await waitUntil(() => connected);
      stream.pushFrame(makeFrame());
      stream.flush();
      stream.endInput();

      const events = await collectUntilEnd(stream);
      stream.close();
      const final = events.find((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT);
      expect(final?.alternatives?.[0]?.confidence).toBeGreaterThan(0.9);
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('defaults to Scribe v1 batch recognition', () => {
    const stt = new STT({ apiKey: 'test-key' });

    expect(stt.model).toBe('scribe_v1');
    expect(stt.provider).toBe('ElevenLabs');
    expect(stt.capabilities.streaming).toBe(false);
    expect(stt.capabilities.interimResults).toBe(true);
    expect(stt.capabilities.alignedTranscript).toBe(false);
  });

  it('maps deprecated useRealtime to realtime model capabilities', () => {
    const stt = new STT({ apiKey: 'test-key', useRealtime: true, includeTimestamps: true });

    expect(stt.model).toBe('scribe_v2_realtime');
    expect(stt.capabilities.streaming).toBe(true);
    expect(stt.capabilities.alignedTranscript).toBe('word');
  });

  it('sends batch recognition form fields and maps word metadata', async () => {
    let request:
      | {
          method?: string;
          url?: string;
          apiKey?: string | string[];
          body: string;
        }
      | undefined;

    const { server, baseURL } = await startHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        request = {
          method: req.method,
          url: req.url,
          apiKey: req.headers['xi-api-key'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            text: 'bonjour livekit',
            language_code: 'fr',
            words: [
              { text: 'bonjour', start: 0.2, end: 0.7, speaker_id: 'speaker-a' },
              { text: 'livekit', start: 0.8, end: 1.1, speaker_id: 'speaker-a' },
            ],
          }),
        );
      });
    });

    try {
      const eleven = new STT({
        apiKey: 'test-key',
        baseURL,
        languageCode: 'en',
        tagAudioEvents: false,
        model: 'scribe_v2',
        keyterms: ['LiveKit', 'ElevenLabs'],
      });

      const event = await eleven.recognize(makeFrame(), {
        language: 'fr',
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });

      expect(request?.method).toBe('POST');
      expect(request?.url).toBe('/speech-to-text?enable_logging=true');
      expect(request?.apiKey).toBe('test-key');
      expect(request?.body).toContain('name="model_id"');
      expect(request?.body).toContain('scribe_v2');
      expect(request?.body).toContain('name="tag_audio_events"');
      expect(request?.body).toContain('false');
      expect(request?.body).toContain('name="language_code"');
      expect(request?.body).toContain('fr');
      expect(request?.body.match(/name="keyterms"/g)).toHaveLength(2);

      expect(event.type).toBe(sttLib.SpeechEventType.FINAL_TRANSCRIPT);
      expect(event.alternatives?.[0]).toMatchObject({
        text: 'bonjour livekit',
        language: 'fr',
        speakerId: 'speaker-a',
        startTime: 0.2,
        endTime: 1.1,
      });
      expect(event.alternatives?.[0]?.words?.map((word) => word.text)).toEqual([
        'bonjour',
        'livekit',
      ]);
    } finally {
      await closeHttpServer(server);
    }
  });

  it.each([
    {
      body: JSON.stringify({
        detail: { code: 'invalid_api_key', message: 'Invalid API key' },
      }),
      message: 'Invalid API key',
      parsed: { detail: { code: 'invalid_api_key', message: 'Invalid API key' } },
    },
    { body: '', message: 'Unknown ElevenLabs error', parsed: '' },
    { body: '{not json', message: '{not json', parsed: '{not json' },
  ])('does not retry a client error with body $body', async ({ body, message, parsed }) => {
    let requests = 0;
    const { server, baseURL } = await startHttpServer((_req, res) => {
      requests += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(body);
    });

    try {
      const eleven = new STT({ apiKey: 'bad-key', baseURL });
      eleven.on('error', () => {});
      const error = await eleven.recognize(makeFrame()).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(APIStatusError);
      expect(error).toMatchObject({ statusCode: 401, message, body: parsed });
      expect(requests).toBe(1);
    } finally {
      await closeHttpServer(server);
    }
  });

  it('streams audio and maps realtime speech events', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const receivedMessages: Record<string, unknown>[] = [];
    let requestUrl = '';
    let requestApiKey: string | string[] | undefined;

    wss.on('connection', (ws, req) => {
      requestUrl = req.url ?? '';
      requestApiKey = req.headers['xi-api-key'];
      let sentEvents = false;
      ws.on('message', (raw) => {
        receivedMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        if (sentEvents) return;
        sentEvents = true;
        ws.send(JSON.stringify({ message_type: 'session_started', session_id: 'session-1' }));
        ws.send(
          JSON.stringify({ message_type: 'partial_transcript', text: 'hel', language_code: 'en' }),
        );
        ws.send(
          JSON.stringify({
            message_type: 'committed_transcript_with_timestamps',
            text: 'hello',
            language_code: 'en',
            words: [{ text: 'hello', start: 0.1, end: 0.4 }],
          }),
        );
        ws.send(JSON.stringify({ message_type: 'committed_transcript_with_timestamps', text: '' }));
        setTimeout(() => ws.close(), 20);
      });
    });

    try {
      const eleven = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v2_realtime' });
      const stream = eleven.stream();
      stream.startTimeOffset = 1;

      await waitUntil(() => requestUrl !== '');

      stream.pushFrame(makeFrame());
      stream.flush();
      stream.endInput();

      const events = await collectUntilEnd(stream);
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(requestApiKey).toBe('test-key');
      expect(url.pathname).toBe('/speech-to-text/realtime');
      expect(url.searchParams.get('model_id')).toBe('scribe_v2_realtime');
      expect(url.searchParams.get('audio_format')).toBe('pcm_16000');
      expect(url.searchParams.get('commit_strategy')).toBe('manual');
      expect(url.searchParams.get('include_language_detection')).toBe('true');
      expect(receivedMessages[0]).toMatchObject({
        message_type: 'input_audio_chunk',
        commit: false,
        sample_rate: 16000,
      });
      expect(typeof receivedMessages[0]?.audio_base_64).toBe('string');

      const speechEvents = events.filter(
        (event) => event.type !== sttLib.SpeechEventType.RECOGNITION_USAGE,
      );
      expect(speechEvents.map((event) => event.type)).toEqual([
        sttLib.SpeechEventType.START_OF_SPEECH,
        sttLib.SpeechEventType.INTERIM_TRANSCRIPT,
        sttLib.SpeechEventType.FINAL_TRANSCRIPT,
        sttLib.SpeechEventType.END_OF_SPEECH,
      ]);
      expect(events.some((event) => event.type === sttLib.SpeechEventType.RECOGNITION_USAGE)).toBe(
        true,
      );
      expect(speechEvents[2]?.alternatives?.[0]).toMatchObject({
        text: 'hello',
        language: 'en',
        startTime: 1.1,
        endTime: 1.4,
      });
      expect(speechEvents[2]?.alternatives?.[0]?.words).toBeUndefined();
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('commits the turn when no audio is left to send', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const sent: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => sent.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    try {
      // 300ms is a whole number of repack chunks, so flush() returns no frames.
      stream.pushFrame(makeFrame(MIN_COMMIT_SAMPLES));
      await waitUntil(() => sent.length === 6);

      stream.flush();
      await waitUntil(() => sent.length === 7);

      expect(sent.map((message) => message.commit)).toEqual([...Array(6).fill(false), true]);
      expect(sent[6]?.audio_base_64).toBe('');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('commits after the buffered audio', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const sent: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => sent.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    try {
      stream.pushFrame(makeFrame(MIN_COMMIT_SAMPLES + 480));
      stream.flush();
      await waitUntil(() => sent.length === 8);

      expect(sent.map((message) => message.commit)).toEqual([...Array(7).fill(false), true]);
      expect(sent[6]?.audio_base_64).not.toBe('');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('defaults audio chunks to 50ms', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const sent: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => sent.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    try {
      stream.pushFrame(makeFrame(MIN_COMMIT_SAMPLES + 784));
      stream.flush();
      await waitUntil(() => sent.some((message) => message.commit === true));
      expect(sent.map((message) => message.commit)).toEqual([...Array(7).fill(false), true]);
      expect(Buffer.from(sent[0]?.audio_base_64 as string, 'base64')).toHaveLength(1600);
      expect(Buffer.from(sent[6]?.audio_base_64 as string, 'base64')).toHaveLength(1568);

      stream.pushFrame(makeFrame());
      await waitUntil(() => sent.length === 9);
      expect(sent[8]?.commit).toBe(false);
      expect(Buffer.from(sent[8]?.audio_base_64 as string, 'base64')).toHaveLength(1600);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('pads a short turn with silence before committing', async () => {
    // Scribe answers a commit with less than 300ms of audio since the previous one with
    // commit_throttled and closes the session, dropping the uncommitted audio. The commit still
    // has to go out on the flush: the caller waits on its final transcript, and no more audio
    // may follow (push-to-talk, session close).
    const { wss, baseURL } = await startWebSocketServer();
    const sent: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => sent.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    const speech = Int16Array.from({ length: 1600 }, (_, index) => index + 1);
    try {
      // the first commit on a connection counts the audio since the connect
      stream.pushFrame(new AudioFrame(speech, 16000, 1, speech.length));
      stream.flush();
      await waitUntil(() => sent.filter((message) => message.commit).length === 1);

      stream.flush();
      await waitUntil(() => sent.filter((message) => message.commit).length === 2);

      const samplesBeforeEachCommit: number[] = [];
      let samples = 0;
      for (const message of sent) {
        if (message.commit) {
          samplesBeforeEachCommit.push(samples);
          samples = 0;
        } else {
          samples += Buffer.from(message.audio_base_64 as string, 'base64').length / 2;
        }
      }
      expect(samplesBeforeEachCommit).toEqual([MIN_COMMIT_SAMPLES, MIN_COMMIT_SAMPLES]);

      const audio = Buffer.concat(
        sent.map((message) => Buffer.from(message.audio_base_64 as string, 'base64')),
      );
      const silenceSamples = MIN_COMMIT_SAMPLES - speech.length + MIN_COMMIT_SAMPLES;
      expect(audio).toEqual(
        Buffer.concat([Buffer.from(speech.buffer), Buffer.alloc(silenceSamples * 2)]),
      );
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it.each([0, -1, 0.5, 100.5, true, false, null, '100'])(
    'rejects invalid audio chunk duration %j',
    (audioChunkDuration) => {
      expect(
        () =>
          new STT({
            apiKey: 'test-key',
            audioChunkDuration: audioChunkDuration as number,
          }),
      ).toThrow('audioChunkDuration must be a positive integer');
    },
  );

  for (const sampleRate of [8000, 16000, 48000] as const) {
    for (const audioChunkDuration of [1, 50, 75, 100, 200]) {
      for (const tailDuration of [0, 1]) {
        it(`preserves ${sampleRate}Hz audio with ${audioChunkDuration}ms chunks and ${tailDuration}ms tail`, async () => {
          const { wss, baseURL } = await startWebSocketServer();
          const sent: Record<string, unknown>[] = [];
          wss.on('connection', (ws) => {
            ws.on('message', (raw) =>
              sent.push(JSON.parse(raw.toString()) as Record<string, unknown>),
            );
          });

          const stream = new STT({
            apiKey: 'test-key',
            baseURL,
            model: 'scribe_v2_realtime',
            sampleRate,
            audioChunkDuration,
          }).stream();
          const totalSamples = Math.floor(
            (sampleRate * (Math.max(audioChunkDuration * 2, 300) + tailDuration)) / 1000,
          );
          const audio = Buffer.from(
            Array.from({ length: totalSamples * 2 }, (_, index) => index % 251),
          );
          const inputFrameBytes = Math.floor((sampleRate * 20) / 1000) * 2;
          const chunkBytes = Math.floor((sampleRate * audioChunkDuration) / 1000) * 2;
          const expectedChunks = Array.from(
            { length: Math.ceil(audio.length / chunkBytes) },
            (_, index) => audio.subarray(index * chunkBytes, (index + 1) * chunkBytes),
          );

          try {
            for (let offset = 0; offset < audio.length; offset += inputFrameBytes) {
              const data = audio.subarray(offset, offset + inputFrameBytes);
              stream.pushFrame(
                new AudioFrame(
                  new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2),
                  sampleRate,
                  1,
                  data.byteLength / 2,
                ),
              );
            }

            await waitUntil(() => sent.length >= Math.floor(audio.length / chunkBytes));
            stream.flush();
            await waitUntil(() => sent.length >= expectedChunks.length + 1);

            expect(sent.slice(0, -1).map((message) => message.audio_base_64)).toEqual(
              expectedChunks.map((chunk) => chunk.toString('base64')),
            );
            expect(sent.map((message) => message.commit)).toEqual([
              ...expectedChunks.map(() => false),
              true,
            ]);
            expect(sent.every((message) => message.sample_rate === sampleRate)).toBe(true);
            expect(sent.at(-1)?.audio_base_64).toBe('');
          } finally {
            stream.close();
            await closeWebSocketServer(wss);
          }
        });
      }
    }
  }

  it('builds realtime query params for language, timestamps, and server VAD', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (ws, req) => {
      requestUrl = req.url ?? '';
      ws.on('message', () => {
        ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'ignored' }));
        ws.send(
          JSON.stringify({
            message_type: 'committed_transcript_with_timestamps',
            text: 'kept',
            language_code: 'en',
            words: [{ text: 'kept', start: 0, end: 0.2 }],
          }),
        );
      });
    });

    try {
      const eleven = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v2_realtime',
        languageCode: 'en',
        includeTimestamps: true,
        serverVad: {
          vadSilenceThresholdSecs: 0.5,
          vadThreshold: 0.4,
          minSpeechDurationMs: 100,
          minSilenceDurationMs: 300,
        },
      });
      const stream = eleven.stream();

      await waitUntil(() => requestUrl !== '');

      stream.pushFrame(makeFrame());
      stream.endInput();

      const events = await collectUntilEnd(stream);
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.searchParams.get('language_code')).toBe('en');
      expect(url.searchParams.get('commit_strategy')).toBe('vad');
      expect(url.searchParams.get('include_language_detection')).toBeNull();
      expect(url.searchParams.get('include_timestamps')).toBe('true');
      expect(url.searchParams.get('vad_silence_threshold_secs')).toBe('0.5');
      expect(url.searchParams.get('vad_threshold')).toBe('0.4');
      expect(url.searchParams.get('min_speech_duration_ms')).toBe('100');
      expect(url.searchParams.get('min_silence_duration_ms')).toBe('300');
      expect(
        events.find((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT)
          ?.alternatives?.[0]?.text,
      ).toBe('kept');
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('includes keyterms in the realtime connection URL', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let requestUrl = '';
    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
      keyterms: ['nginx', 'Grafana Loki', 'Ærø'],
    }).stream();
    try {
      await waitUntil(() => requestUrl !== '');

      expect(requestUrl).toContain('keyterms=nginx');
      expect(requestUrl).toContain('keyterms=Grafana%20Loki');
      expect(requestUrl).toContain('keyterms=%C3%86r%C3%B8');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('escapes query delimiters in realtime keyterms', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let requestUrl = '';
    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
      keyterms: ['Smith & Sons', 'C#'],
    }).stream();
    try {
      await waitUntil(() => requestUrl !== '');

      expect(requestUrl).toContain('keyterms=Smith%20%26%20Sons');
      expect(requestUrl).toContain('keyterms=C%23');
      expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.getAll('keyterms')).toEqual([
        'Smith & Sons',
        'C#',
      ]);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('omits realtime keyterms when not provided', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let requestUrl = '';
    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    const stream = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v2_realtime' }).stream();
    try {
      await waitUntil(() => requestUrl !== '');

      expect(requestUrl).not.toContain('keyterms=');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('forwards keyterm updates to active streams', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_ws, req) => {
      urls.push(req.url ?? '');
    });

    const eleven = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v2_realtime' });
    const stream = eleven.stream();
    try {
      await waitUntil(() => urls.length === 1);
      eleven.updateOptions({ keyterms: ['nginx'] });
      await waitUntil(() => urls.length === 2, 2000);

      expect(new URL(`ws://127.0.0.1${urls[1]}`).searchParams.getAll('keyterms')).toEqual([
        'nginx',
      ]);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('updates stream keyterms and reconnects', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_ws, req) => {
      urls.push(req.url ?? '');
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    try {
      await waitUntil(() => urls.length === 1);
      stream.updateOptions({ keyterms: ['nginx'] });
      await waitUntil(() => urls.length === 2, 2000);

      expect(new URL(`ws://127.0.0.1${urls[1]}`).searchParams.getAll('keyterms')).toEqual([
        'nginx',
      ]);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('updates server VAD on active streams and reconnects in place', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const urls: string[] = [];

    wss.on('connection', (ws, req) => {
      urls.push(req.url ?? '');
      ws.on('message', () => {});
    });

    try {
      const eleven = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v2_realtime' });
      const stream = eleven.stream();

      await waitUntil(() => urls.length === 1);
      eleven.updateOptions({ serverVad: { vadSilenceThresholdSecs: 0.5 } });
      await waitUntil(() => urls.length === 2, 2000);
      eleven.updateOptions({ serverVad: null });
      await waitUntil(() => urls.length === 3, 2000);
      stream.close();

      const first = new URL(`ws://127.0.0.1${urls[0]}`);
      const second = new URL(`ws://127.0.0.1${urls[1]}`);
      const third = new URL(`ws://127.0.0.1${urls[2]}`);
      expect(first.searchParams.get('commit_strategy')).toBe('manual');
      expect(second.searchParams.get('commit_strategy')).toBe('vad');
      expect(third.searchParams.get('commit_strategy')).toBe('manual');
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});
