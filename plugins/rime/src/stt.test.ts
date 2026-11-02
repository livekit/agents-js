// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  Agent,
  AgentSession,
  VAD,
  type VADEvent,
  VADEventType,
  VADStream,
  stt,
  voice,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import * as sdk from '@rimelabs/sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  AudioRecognition,
  RecognitionHooks,
} from '../../../agents/dist/voice/audio_recognition.js';
import { STT, type STTOptions, type STTOutputContract } from './stt.js';
import { toWav } from './stt_audio.js';
import * as bridge from './stt_sdk.js';
import {
  type RequestOptions,
  type SDK,
  type SDKStream,
  type TranscriptUpdate,
  abortable,
} from './stt_sdk.js';

function frame(rate = 16000, channels = 1, samples = rate / 10): AudioFrame {
  const data = new Int16Array(samples * channels);
  for (let i = 0; i < data.length; i++) data[i] = 20000 + (i % channels) * 1000;
  return new AudioFrame(data, rate, channels, samples);
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Detector extends VAD {
  label = 'test.VAD';
  streams: DetectorStream[] = [];
  override close = vi.fn(async () => {});
  constructor() {
    super({ updateInterval: 32 });
  }
  stream() {
    const stream = new DetectorStream(this);
    this.streams.push(stream);
    return stream;
  }
}
class DetectorStream extends VADStream {
  frames: AudioFrame[] = [];
  constructor(owner: VAD) {
    super(owner);
    void (async () => {
      try {
        while (true) {
          const result = await this.inputReader.read();
          if (result.done) break;
          if (typeof result.value !== 'symbol') this.frames.push(result.value);
        }
      } finally {
        this.close();
      }
    })();
  }
  get isClosed() {
    return this.closed;
  }
  async send(type: VADEventType, frames: AudioFrame[] = [frame()], timing: Partial<VADEvent> = {}) {
    await this.outputWriter.write({
      type,
      frames,
      timestamp: Date.now(),
      speechDuration: 0,
      silenceDuration: 500,
      inferenceDuration: 20,
      samplesIndex: 0,
      probability: 1,
      speaking: type !== VADEventType.END_OF_SPEECH,
      rawAccumulatedSilence: 0,
      rawAccumulatedSpeech: 0,
      ...timing,
    });
  }
}
class ProviderStream implements SDKStream {
  requestId = 'test-request';
  readonly audio: Uint8Array[] = [];
  readonly controller = new AbortController();
  closed = false;
  readonly iterator: AsyncGenerator<TranscriptUpdate>;
  constructor(
    readonly source: AsyncIterable<Uint8Array>,
    readonly options: RequestOptions,
    generate: (self: ProviderStream) => AsyncGenerator<TranscriptUpdate>,
  ) {
    options.signal.addEventListener('abort', this.abort, { once: true });
    this.iterator = generate(this);
  }
  private abort = () => this.controller.abort(new sdk.RimeCancelledError('private cancellation'));
  async *chunks() {
    const iterator = this.source[Symbol.asyncIterator]();
    while (true) {
      const result = await abortable(iterator.next(), this.controller.signal);
      if (result.done) break;
      this.audio.push(result.value);
      yield result.value;
    }
  }
  async wait(promise: Promise<unknown>) {
    await abortable(promise, this.controller.signal);
  }
  async next() {
    return abortable(this.iterator.next(), this.controller.signal);
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  async return(): Promise<IteratorResult<TranscriptUpdate>> {
    await this.cancel();
    return { done: true, value: undefined };
  }
  async cancel() {
    if (this.closed) return;
    this.closed = true;
    this.options.signal.removeEventListener('abort', this.abort);
    this.abort();
    await this.iterator.return(undefined).catch(() => {});
  }
}
async function* normal(self: ProviderStream): AsyncGenerator<TranscriptUpdate> {
  let text = '';
  for await (const _chunk of self.chunks()) {
    const delta = text ? ' \ncream' : 'Ice';
    text += delta;
    yield interim(self, text, delta);
  }
  yield { kind: 'final', text, language: 'en' };
}
function provider(generate = normal) {
  const streams: ProviderStream[] = [];
  const transcribe = vi.fn(async (_audio: Uint8Array, _options: RequestOptions) => ({
    text: 'Hello.',
    language: 'en',
    requestId: 'unary-id' as string | null,
  }));
  const client = {
    stt: {
      transcribe,
      stream: vi.fn((source: AsyncIterable<Uint8Array>, options: RequestOptions) => {
        const stream = new ProviderStream(source, options, generate);
        streams.push(stream);
        return stream;
      }),
    },
    close: vi.fn(async () => {}),
  };
  const module = {
    ...sdk,
    Rime: class {
      constructor() {
        return client;
      }
    },
  } as unknown as SDK;
  return { streams, client, module };
}

const contracts = ['revised_hypotheses', 'append_fragments'] as const;
const never = new Promise<never>(() => {});
const owners: STT[] = [];
const readers: Promise<void>[] = [];
const sessions: AgentSession[] = [];
let mock: ReturnType<typeof provider>;
let detector: Detector;
let owner: STT;
let stream: stt.SpeechStream;
let events: stt.SpeechEvent[];
let reader: Promise<void>;

function createSTT(options: STTOptions = {}) {
  const value = new STT({
    apiKey: 'test-key',
    connOptions: { maxRetry: 0, timeoutMs: 2000 },
    ...options,
  });
  owners.push(value);
  return value;
}
function watch(
  source: AsyncIterable<stt.SpeechEvent>,
  consume?: (event: stt.SpeechEvent) => Promise<void>,
) {
  const events: stt.SpeechEvent[] = [];
  const done = (async () => {
    for await (const event of source) {
      events.push(event);
      await consume?.(event);
    }
  })();
  readers.push(done);
  return { events, done };
}
function start(contract: STTOutputContract = 'revised_hypotheses', timeoutMs = 2000) {
  owner = createSTT({ vad: detector, outputContract: contract, connOptions: { timeoutMs } });
  owner.on('error', () => {});
  stream = owner.stream({ connOptions: { timeoutMs, maxRetry: 5, retryIntervalMs: 0 } });
  ({ events, done: reader } = watch(stream));
}
async function vad() {
  await vi.waitFor(() => expect(detector.streams).not.toHaveLength(0));
  return detector.streams.at(-1)!;
}
async function utterance() {
  const value = await vad();
  await value.send(VADEventType.START_OF_SPEECH);
  await value.send(VADEventType.END_OF_SPEECH);
}
async function finish() {
  stream.endInput();
  await reader;
}
async function drain(self: ProviderStream) {
  for await (const _chunk of self.chunks()) {
    /* upload */
  }
}
function interim(self: ProviderStream, text: string, delta = text): TranscriptUpdate {
  return self.options.outputContract === 'append_fragments'
    ? { kind: 'delta', text: delta }
    : { kind: 'partial', text };
}
function eventTypes(events: stt.SpeechEvent[], filter?: number[]) {
  return events
    .filter((event) => !filter || filter.includes(event.type))
    .map((event) => event.type);
}
function gatedProvider(
  updates?: (self: ProviderStream, index: number) => Iterable<TranscriptUpdate>,
) {
  const release = [deferred(), deferred()];
  const uploaded = [deferred(), deferred()];
  mock = provider(async function* (self) {
    const index = mock.streams.indexOf(self);
    for await (const _chunk of self.chunks()) {
      if (updates) yield* updates(self, index);
    }
    uploaded[index]!.resolve();
    await self.wait(release[index]!.promise);
    yield { kind: 'final', text: index ? 'second' : 'first', language: 'en' };
  });
  return { release, uploaded };
}
beforeEach(() => {
  mock = provider();
  detector = new Detector();
  vi.spyOn(bridge, 'loadSDK').mockImplementation(async () => mock.module);
});
afterEach(async () => {
  try {
    await Promise.all(owners.splice(0).map((value) => value.close()));
    await Promise.all(readers.splice(0));
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  } finally {
    vi.restoreAllMocks();
  }
});

it.each([
  [16000, 1],
  [48000, 1],
  [48000, 2],
  [44100, 2],
])(
  'converts %i Hz/%i channels to complete WAV, flushes resampling, and maps metrics',
  async (rate, channels) => {
    const value = createSTT();
    const metrics = vi.fn();
    value.on('metrics_collected', metrics);
    const event = await value.recognize([frame(rate, channels), frame(rate, channels)]);
    const wav = Buffer.from(mock.client.stt.transcribe.mock.calls[0]![0]);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(6400);
    const samples = Array.from({ length: 2800 }, (_, i) => wav.readInt16LE(44 + 2 * (i + 200)));
    expect(samples.reduce((a, b) => a + b) / samples.length).toBeCloseTo(
      20000 + (channels - 1) * 500,
      0,
    );
    expect(event).toMatchObject({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId: 'unary-id',
      alternatives: [{ text: 'Hello.', language: 'en', startTime: 0, endTime: 0, confidence: 0 }],
    });
    expect(event.alternatives![0].words).toBeUndefined();
    expect(metrics).toHaveBeenCalledWith(
      expect.objectContaining({
        audioDurationMs: 200,
        streamed: false,
        metadata: { modelProvider: 'Rime', modelName: 'rime-stt' },
      }),
    );
  },
);

it('constructs synchronously and snapshots options/keyterms before lazy initialization', async () => {
  const gate = deferred<bridge.SDK>();
  vi.mocked(bridge.loadSDK).mockReturnValue(gate.promise);
  const hints = ['Rime'];
  const session = ['Rime', 'LiveKit'];
  const value = createSTT({
    contextTerms: hints,
    language: 'en-US',
    mode: 'verbatim',
    connOptions: { timeoutMs: 2500, maxRetry: 0 },
  });
  expect(bridge.loadSDK).not.toHaveBeenCalled();
  hints.push('mutation');
  value._updateSessionKeyterms(session);
  session.length = 0;
  const result = value.recognize(frame());
  value.updateOptions({ contextTerms: ['new'], language: 'es', mode: 'written' });
  gate.resolve(mock.module);
  await result;
  expect(mock.client.stt.transcribe.mock.calls[0]![1]).toMatchObject({
    language: 'en-US',
    mode: 'verbatim',
    contextTerms: ['Rime', 'LiveKit'],
    timeout: 2.5,
  });
  await value.recognize(frame());
  expect(mock.client.stt.transcribe.mock.calls[1]![1]).toMatchObject({
    language: 'es',
    mode: 'written',
    contextTerms: ['new', 'Rime', 'LiveKit'],
  });
});

it('keeps defaults, empty results and absent request identities', async () => {
  mock.client.stt.transcribe.mockResolvedValue({ text: '', language: 'es', requestId: null });
  const value = createSTT();
  expect(value.capabilities).toMatchObject({
    streaming: false,
    interimResults: false,
    keyterms: true,
  });
  expect(await value.recognize(frame())).toMatchObject({
    requestId: '',
    alternatives: [{ text: '', language: 'es' }],
  });
  expect(mock.client.stt.transcribe.mock.calls[0]![1]).toMatchObject({
    language: 'en',
    mode: 'written',
    contextTerms: [],
  });
});

it.each([[], [frame(), frame(48000)], [frame(), frame(16000, 2)], frame(16000, 1, 0)])(
  'rejects invalid audio without SDK initialization %#',
  async (audio) => {
    await expect(createSTT().recognize(audio)).rejects.toMatchObject({ retryable: false });
    expect(bridge.loadSDK).not.toHaveBeenCalled();
  },
);
it('rejects malformed frame metadata and excessive WAV size', () => {
  const invalid = frame();
  invalid.samplesPerChannel++;
  expect(() => toWav(invalid)).toThrow(APIError);
  expect(() => toWav(frame(16000, 1, 8388608))).toThrow('maximum WAV size');
});
it.each(['Rime', [123]])(
  'validates context terms on construction and updates %#',
  (contextTerms) => {
    expect(() => createSTT({ contextTerms: contextTerms as unknown as string[] })).toThrow(
      'array of strings',
    );
    expect(() =>
      createSTT().updateOptions({ contextTerms: contextTerms as unknown as string[] }),
    ).toThrow('array of strings');
  },
);
it('validates contract, connection configuration and native VAD requirements', () => {
  expect(() => createSTT({ outputContract: 'append_fragments' })).toThrow('requires a vad');
  expect(() => createSTT({ outputContract: 'bad' as 'append_fragments' })).toThrow('Unsupported');
  expect(() => createSTT({ connOptions: { timeoutMs: 0 } })).toThrow('connection options');
  expect(() => createSTT().stream()).toThrow('Pass vad');
});

it.each([
  [sdk.RimeTimeoutError, APITimeoutError, true],
  [sdk.RimeUnavailableError, APIConnectionError, true],
  [sdk.RimeAuthenticationError, APIStatusError, false],
  [sdk.RimePermissionError, APIStatusError, false],
  [sdk.RimeInputError, APIStatusError, false],
  [sdk.RimeAudioFormatError, APIStatusError, false],
  [sdk.RimeResourceLimitError, APIStatusError, false],
  [sdk.RimeCancelledError, APIStatusError, false],
  [sdk.RimeStreamError, APIStatusError, false],
] as const)(
  'sanitizes %s and retries only unary timeout/unavailability',
  async (ErrorClass, LiveKitError, retryable) => {
    const value = createSTT();
    const secret = 'private provider message bearer credentials';
    mock.client.stt.transcribe.mockRejectedValueOnce(new ErrorClass(secret, 'failed-id'));
    const error = await value.recognize(frame()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LiveKitError);
    expect(error).toMatchObject({ retryable, body: { request_id: 'failed-id' } });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain(secret);
    if (error instanceof APIStatusError) expect(error.statusCode).toBe(-1);
    value.updateOptions({ connOptions: { maxRetry: 1, retryIntervalMs: 0 } });
    mock.client.stt.transcribe.mockRejectedValueOnce(new ErrorClass(secret));
    const result = value.recognize(frame());
    if (retryable)
      await expect(result).resolves.toHaveProperty('type', stt.SpeechEventType.FINAL_TRANSCRIPT);
    else await expect(result).rejects.toHaveProperty('retryable', false);
    expect(mock.client.stt.transcribe).toHaveBeenCalledTimes(retryable ? 3 : 2);
  },
);

it.each(['abort', 'close', 'timeout'])('settles pending unary work on %s', async (finish) => {
  mock.client.stt.transcribe.mockImplementation(async (_audio, options) => {
    await bridge.abortable(never, options.signal);
    throw new Error('unreachable');
  });
  const value = createSTT({
    connOptions: { timeoutMs: finish === 'timeout' ? 20 : 2000, maxRetry: 0 },
  });
  const abort = new AbortController();
  const result = value.recognize(frame(), abort.signal);
  const assertion = expect(result).rejects.toMatchObject({ retryable: finish === 'timeout' });
  await vi.waitFor(() => expect(mock.client.stt.transcribe).toHaveBeenCalled());
  if (finish === 'abort') abort.abort(new Error('private cause'));
  if (finish === 'close') await value.close();
  await assertion;
});
it('observes lazy initialization failure and closes an initialization still pending at shutdown', async () => {
  vi.mocked(bridge.loadSDK).mockRejectedValueOnce(
    new APIError('Install @rimelabs/sdk', { retryable: false }),
  );
  await expect(createSTT().recognize(frame())).rejects.toThrow('Install @rimelabs/sdk');
  const gate = deferred<bridge.SDK>();
  vi.mocked(bridge.loadSDK).mockReturnValueOnce(gate.promise);
  const value = createSTT();
  const request = value.recognize(frame());
  const assertion = expect(request).rejects.toThrow('cancelled');
  const closing = value.close();
  gate.resolve(mock.module);
  await closing;
  await assertion;
  expect(mock.client.close).toHaveBeenCalledOnce();
});

it('supports the real StreamAdapter and preserves caller-owned VAD', async () => {
  const value = createSTT();
  const adapter = new stt.StreamAdapter(value, detector);
  const stream = adapter.stream();
  const result = watch(stream);
  await detector.streams[0]!.send(0);
  await detector.streams[0]!.send(2);
  await vi.waitFor(() => expect(mock.client.stt.transcribe).toHaveBeenCalledOnce());
  stream.endInput();
  await result.done;
  expect(result.events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true);
  stream.close();
  await value.close();
  expect(detector.close).not.toHaveBeenCalled();
});

it.each(contracts)(
  'uploads live audio once and emits cumulative %s results with exact whitespace',
  async (contract) => {
    start(contract);
    const metrics = vi.fn();
    owner.on('metrics_collected', metrics);
    const value = await vad();
    await value.send(VADEventType.INFERENCE_DONE, [frame(16000, 1, 1)]);
    const prefix = frame();
    const next = frame(16000, 1, 320);
    await value.send(VADEventType.START_OF_SPEECH, [prefix]);
    await vi.waitFor(() => expect(events.at(-1)?.alternatives?.[0].text).toBe('Ice'));
    expect(mock.streams[0]!.closed).toBe(false);
    await value.send(VADEventType.INFERENCE_DONE, [next]);
    await vi.waitFor(() => expect(events.at(-1)?.alternatives?.[0].text).toBe('Ice \ncream'));
    const beforeEnd = Date.now();
    await value.send(VADEventType.END_OF_SPEECH, [prefix, next], {
      timestamp: 10000,
      silenceDuration: 500,
      inferenceDuration: 20,
    });
    await finish();
    expect(mock.streams[0]!.audio.map((chunk) => chunk.length)).toEqual([3200, 640]);
    expect(eventTypes(events)).toEqual([0, 1, 1, 2, 4, 3]);
    expect(events[3]).toMatchObject({
      requestId: 'test-request',
      alternatives: [{ text: 'Ice \ncream', language: 'en' }],
    });
    expect(events[3]!.speechEndTime).toBeGreaterThanOrEqual(beforeEnd - 520);
    expect(events[3]!.speechEndTime).toBeLessThanOrEqual(Date.now() - 520);
    expect(events[4]!.recognitionUsage!.audioDuration).toBeCloseTo(0.12);
    expect(metrics).toHaveBeenCalledOnce();
    expect(metrics).toHaveBeenCalledWith(
      expect.objectContaining({
        audioDurationMs: 120,
        streamed: true,
        metadata: { modelProvider: 'Rime', modelName: 'rime-stt' },
      }),
    );
    expect(mock.streams[0]!.options.timeout).toBe(2);
    expect(value.isClosed).toBe(true);
    expect(detector.close).not.toHaveBeenCalled();
  },
);
it('replacement partials can revise prior text', async () => {
  mock = provider(async function* (self) {
    for await (const _chunk of self.chunks()) {
      yield { kind: 'partial', text: 'I scream' };
      yield { kind: 'partial', text: 'Ice cream' };
    }
    yield { kind: 'final', text: 'Ice cream', language: 'es' };
  });
  start();
  await utterance();
  await finish();
  expect(events.filter((e) => e.alternatives).map((e) => e.alternatives![0].text)).toEqual([
    'I scream',
    'Ice cream',
    'Ice cream',
  ]);
  expect(events.find((e) => e.type === 2)?.alternatives![0].language).toBe('es');
});
it('snapshots each utterance, user terms and session terms', async () => {
  start();
  const terms = ['Rime'];
  owner.updateOptions({ language: 'en-US', contextTerms: terms });
  terms.push('mutation');
  owner._updateSessionKeyterms(['Rime', 'LiveKit']);
  await utterance();
  await vi.waitFor(() => expect(mock.streams).toHaveLength(1));
  owner.updateOptions({ language: 'es', mode: 'verbatim', contextTerms: ['new'] });
  await utterance();
  await finish();
  expect(mock.streams.map((s) => s.options)).toMatchObject([
    { language: 'en-US', mode: 'written', contextTerms: ['Rime', 'LiveKit'] },
    { language: 'es', mode: 'verbatim', contextTerms: ['new', 'Rime', 'LiveKit'] },
  ]);
});
it('silence does not initialize the SDK or start any request', async () => {
  start();
  await vad();
  stream.pushFrame(frame());
  await finish();
  expect(events).toEqual([]);
  expect(bridge.loadSDK).not.toHaveBeenCalled();
});
it('successful empty transcripts remain finals', async () => {
  mock = provider(async function* (self) {
    await drain(self);
    yield { kind: 'final', text: '', language: 'en' };
  });
  start();
  await utterance();
  await finish();
  expect(eventTypes(events)).toEqual([0, 2, 4, 3]);
});
it.each(['eof', 'failure', 'partial-final-failure'])(
  'does not fabricate finals or retry after %s',
  async (failure) => {
    mock = provider(async function* (self) {
      for await (const _chunk of self.chunks()) {
        yield { kind: 'delta', text: 'fragment' };
      }
      if (failure === 'partial-final-failure')
        yield { kind: 'final', text: 'fragment', language: 'en' };
      if (failure !== 'eof')
        throw new sdk.RimeUnavailableError('private-provider-content', 'failed-id');
    });
    start('append_fragments');
    await utterance();
    await finish();
    expect(events.some((e) => e.type === 2 || e.type === 3 || e.type === 4)).toBe(false);
    expect(mock.streams).toHaveLength(1);
    expect(stream.terminalError).toHaveProperty('retryable', false);
    expect(String(stream.terminalError)).not.toContain('private-provider-content');
  },
);
it('finishes an active utterance at endInput without an END event', async () => {
  start();
  await (await vad()).send(VADEventType.START_OF_SPEECH);
  await finish();
  expect(eventTypes(events)).toEqual([0, 1, 2, 4, 3]);
});
it('flush drains resampling, replaces segmentation and accepts subsequent audio', async () => {
  start();
  const first = await vad();
  stream.pushFrame(frame(48000));
  await first.send(VADEventType.START_OF_SPEECH);
  stream.flush();
  stream.pushFrame(frame(44100));
  await vi.waitFor(() => expect(detector.streams).toHaveLength(2));
  const second = detector.streams[1]!;
  await second.send(VADEventType.START_OF_SPEECH);
  await finish();
  expect(first.frames.reduce((sum, f) => sum + f.samplesPerChannel, 0)).toBe(1600);
  expect(second.frames.reduce((sum, f) => sum + f.samplesPerChannel, 0)).toBe(1600);
  expect([...first.frames, ...second.frames].every((f) => f.sampleRate === 16000)).toBe(true);
  expect(mock.streams).toHaveLength(2);
  expect(first.isClosed && second.isClosed).toBe(true);
});
it('cancels active initialization, VAD, reader and upload without a final', async () => {
  const gate = deferred<bridge.SDK>();
  vi.mocked(bridge.loadSDK).mockReturnValue(gate.promise);
  start();
  await (await vad()).send(VADEventType.START_OF_SPEECH);
  await vi.waitFor(() => expect(bridge.loadSDK).toHaveBeenCalledOnce());
  const closing = owner.close();
  gate.resolve(mock.module);
  await closing;
  await reader;
  expect(events.some((e) => e.type === 2)).toBe(false);
  expect(detector.streams[0]!.isClosed).toBe(true);
  expect(mock.client.close).toHaveBeenCalledOnce();
});
it('stream close before run starts settles parent close', async () => {
  start();
  await stream.close();
  await owner.close();
  expect(mock.streams).toHaveLength(0);
});
it('stream timeout aborts active work and never retries', async () => {
  mock = provider(async function* (self) {
    for await (const _chunk of self.chunks()) yield { kind: 'partial', text: 'hello' };
    await self.wait(never);
  });
  start('revised_hypotheses', 30);
  await utterance();
  await reader;
  expect(mock.streams[0]!.closed).toBe(true);
  expect(mock.streams).toHaveLength(1);
  expect(events.some((e) => e.type === 2)).toBe(false);
});
it('bounds all pending uploads to 320000 bytes', async () => {
  mock = provider(async function* (self) {
    await self.wait(never);
  });
  start();
  const value = await vad();
  await value.send(VADEventType.START_OF_SPEECH, [frame(16000, 1, 80000)]);
  await value.send(VADEventType.END_OF_SPEECH);
  await value.send(VADEventType.START_OF_SPEECH, [frame(16000, 1, 80000)]);
  await value.send(VADEventType.INFERENCE_DONE, [frame(16000, 1, 1)]);
  await reader;
  expect(stream.terminalError?.message).toContain('backlog');
  expect(events.some((e) => e.type === 2)).toBe(false);
  expect(mock.streams.every((s) => s.closed)).toBe(true);
});
it('bounds pending utterances to eight', async () => {
  mock = provider(async function* (self) {
    await drain(self);
    await self.wait(never);
  });
  start();
  for (let i = 0; i < 9; i++) await utterance();
  await reader;
  expect(stream.terminalError?.message).toContain('utterance limit');
  expect(mock.streams).toHaveLength(8);
  expect(mock.streams.every((s) => s.closed)).toBe(true);
});
it.each([0, 1, null])(
  'cancels all parallel work after request %s fails or parent closes',
  async (failing) => {
    const release = deferred();
    mock = provider(async function* (self) {
      await drain(self);
      if (mock.streams.indexOf(self) === failing) {
        await self.wait(release.promise);
        throw new sdk.RimeInputError('private', 'failed-id');
      }
      await self.wait(never);
    });
    start();
    await utterance();
    await utterance();
    await vi.waitFor(() => expect(mock.streams).toHaveLength(2));
    if (failing === null) await owner.close();
    else release.resolve();
    await reader;
    expect(mock.streams.every((s) => s.closed)).toBe(true);
    if (failing !== null) {
      expect(stream.terminalError).toBeInstanceOf(APIStatusError);
      expect((stream.terminalError as APIStatusError).requestId).toBe('failed-id');
    }
  },
);
it.each(contracts)(
  'uploads later %s utterances before earlier finals and coalesces buffered interims',
  async (contract) => {
    const { release, uploaded } = gatedProvider(function* (self) {
      for (let i = 0; i < 50; i++) yield interim(self, `${i}`, 'x');
    });
    start(contract);
    await utterance();
    await uploaded[0]!.promise;
    stream.flush();
    await vi.waitFor(() => expect(detector.streams).toHaveLength(2));
    await utterance();
    await uploaded[1]!.promise;
    expect(events.filter((e) => e.type === 0)).toHaveLength(1);
    release[1]!.resolve();
    await vi.waitFor(() => expect(mock.streams[1]!.closed).toBe(true));
    stream.endInput();
    release[0]!.resolve();
    await reader;
    expect(eventTypes(events, [0, 2, 3])).toEqual([0, 2, 3, 0, 2, 3]);
    const second = events.slice(eventTypes(events).lastIndexOf(0));
    expect(second.filter((e) => e.type === 1)).toHaveLength(1);
    expect(second.find((e) => e.type === 1)?.alternatives![0].text).toBe(
      contract === 'append_fragments' ? 'x'.repeat(50) : '49',
    );
  },
);

it('fails during active speech without waiting for VAD end or replaying audio', async () => {
  mock = provider(async function* (self) {
    for await (const _chunk of self.chunks()) {
      yield { kind: 'partial', text: 'unfinished' };
      throw new sdk.RimeUnavailableError('sensitive provider body', 'active-failed');
    }
  });
  start();
  await (await vad()).send(VADEventType.START_OF_SPEECH);
  await reader;
  expect(mock.streams).toHaveLength(1);
  expect(mock.streams[0]!.closed).toBe(true);
  expect(detector.streams[0]!.isClosed).toBe(true);
  expect(events.some((event) => [2, 3, 4].includes(event.type))).toBe(false);
  expect(stream.terminalError).toMatchObject({
    retryable: false,
    body: { request_id: 'active-failed' },
  });
});

it('close joins an active upload and transcript reader', async () => {
  start();
  await (await vad()).send(VADEventType.START_OF_SPEECH);
  await vi.waitFor(() => expect(mock.streams[0]?.audio).toHaveLength(1));
  await stream.close();
  await reader;
  expect(mock.streams[0]!.closed).toBe(true);
  expect(detector.streams[0]!.isClosed).toBe(true);
  expect(events.some((event) => event.type === 2)).toBe(false);
});

it('rejects stereo native input and invalid VAD audio without creating finals', async () => {
  start();
  expect(() => stream.pushFrame(frame(16000, 2))).toThrow('mono');
  await (await vad()).send(VADEventType.START_OF_SPEECH, [frame(48000)]);
  await reader;
  expect(stream.terminalError?.message).toContain('16 kHz');
  expect(events.some((event) => event.type === 2)).toBe(false);
});

it('settles cleanup even if an owned VAD stream close throws synchronously', async () => {
  start();
  const value = await vad();
  const original = value.close.bind(value);
  vi.spyOn(value, 'close').mockImplementationOnce(() => {
    original();
    throw new Error('private cleanup cause');
  });
  await value.send(VADEventType.START_OF_SPEECH);
  await vi.waitFor(() => expect(mock.streams[0]?.audio).toHaveLength(1));
  await owner.close();
  await reader;
  expect(mock.streams[0]!.closed).toBe(true);
});

it('captures wall-clock boundaries before deferred publication, ignoring relative VAD timestamps', async () => {
  const { release, uploaded } = gatedProvider();
  start();
  const value = await vad();
  const before = Date.now();
  for (let i = 0; i < 2; i++) {
    await value.send(VADEventType.START_OF_SPEECH, [frame()], { timestamp: 32 + i * 1000 });
    await value.send(VADEventType.END_OF_SPEECH, [frame()], { timestamp: 64 + i * 1000 });
    await uploaded[i]!.promise;
  }
  const capturedBy = Date.now();
  stream.endInput();
  release[1]!.resolve();
  release[0]!.resolve();
  await reader;
  const starts = events.filter((event) => event.type === 0);
  for (const event of starts) {
    expect(event.createdAt).toBeGreaterThanOrEqual(before);
    expect(event.createdAt).toBeLessThanOrEqual(capturedBy);
  }
  for (const event of events.filter((event) => event.type === 2 || event.type === 3)) {
    expect(event.speechEndTime).toBeGreaterThanOrEqual(before - 520);
    expect(event.speechEndTime).toBeLessThanOrEqual(capturedBy - 520);
  }
});

interface RecognitionInternals {
  onSTTEvent(event: stt.SpeechEvent): Promise<void>;
  hooks: RecognitionHooks;
  speaking: boolean;
  audioTranscript: string;
}

const orderingCases = contracts.flatMap((contract) =>
  [false, true].flatMap((secondFinishesFirst) =>
    [false, true].map(
      (commitBetweenEvents) =>
        [
          `real AgentSession/AudioRecognition: ${contract}, second first=${secondFinishesFirst}, commit between=${commitBetweenEvents}`,
          { contract, secondFinishesFirst, commitBetweenEvents },
        ] as const,
    ),
  ),
);
it.each(orderingCases)(
  '%s',
  async (_name, { contract, secondFinishesFirst, commitBetweenEvents }) => {
    const { release, uploaded } = gatedProvider(function* (self, index) {
      yield interim(self, index ? 'second' : 'first');
    });
    const session = new AgentSession({
      vad: null,
      stt: new stt.testing.FakeSTT(),
      llm: new voice.testing.FakeLLM(),
      turnHandling: {
        turnDetection: 'stt',
        endpointing: { minDelay: 0, maxDelay: 0 },
        interruption: { mode: 'vad' },
      },
    });
    sessions.push(session);
    await session.start({ agent: new Agent({ instructions: 'Testing speech order.' }) });
    const recognition = (session as unknown as { activity: { audioRecognition: AudioRecognition } })
      .activity.audioRecognition;
    const internal = recognition as unknown as RecognitionInternals;
    const turns: string[] = [];
    const finals: string[] = [];
    vi.spyOn(internal.hooks, 'onEndOfTurn').mockImplementation(async (info) => {
      turns.push(info.newTranscript);
      return true;
    });
    vi.spyOn(internal.hooks, 'onFinalTranscript').mockImplementation((event) => {
      finals.push(event.alternatives![0].text);
    });
    owner = createSTT({
      vad: detector,
      outputContract: contract,
      connOptions: { timeoutMs: 3000 },
    });
    owner.on('error', () => {});
    stream = owner.stream();
    ({ events, done: reader } = watch(stream, async (event) => {
      await internal.onSTTEvent(event);
      if (commitBetweenEvents && event.type === stt.SpeechEventType.END_OF_SPEECH)
        await recognition.waitForEndOfTurnTask();
    }));
    const observed = events;
    await vi.waitFor(() => expect(detector.streams).toHaveLength(1));
    for (let i = 0; i < 2; i++) {
      await utterance();
      await uploaded[i]!.promise;
    }
    stream.endInput();
    if (secondFinishesFirst) {
      release[1]!.resolve();
      await vi.waitFor(() => expect(mock.streams[1]!.closed).toBe(true));
    }
    release[0]!.resolve();
    if (!secondFinishesFirst) {
      await vi.waitFor(() => expect(observed.filter((e) => e.type === 0)).toHaveLength(2));
      expect(internal.speaking).toBe(true);
      release[1]!.resolve();
    }
    await reader;
    await recognition.waitForEndOfTurnTask();
    expect(finals).toEqual(['first', 'second']);
    expect(turns.join(' ')).toBe('first second');
    expect(internal.audioTranscript).toBe('');
    if (commitBetweenEvents) expect(turns).toEqual(['first', 'second']);
    expect(eventTypes(observed, [0, 2, 3])).toEqual([0, 2, 3, 0, 2, 3]);
  },
);
