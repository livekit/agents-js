// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { stt } from '@livekit/agents';
import { APIStatusError, VADEventType } from '@livekit/agents';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STT, type STTOutputContract } from './stt.js';
import * as bridge from './stt_sdk.js';
import { Detector, deferred, frame, provider, sdk } from './stt_test_helpers.js';

let mock: ReturnType<typeof provider>;
let detector: Detector;
let owner: STT;
let stream: stt.SpeechStream;
let events: stt.SpeechEvent[];
let reader: Promise<void>;
function start(contract: STTOutputContract = 'revised_hypotheses', timeoutMs = 2000) {
  owner = new STT({
    apiKey: 'test-key',
    vad: detector,
    outputContract: contract,
    connOptions: { timeoutMs },
  });
  owner.on('error', () => {});
  stream = owner.stream({ connOptions: { timeoutMs, maxRetry: 5, retryIntervalMs: 0 } });
  events = [];
  reader = (async () => {
    for await (const event of stream) events.push(event);
  })();
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
beforeEach(() => {
  mock = provider();
  detector = new Detector();
  vi.spyOn(bridge, 'loadSDK').mockImplementation(async () => mock.module);
});
afterEach(async () => {
  await owner?.close();
  await reader;
  vi.restoreAllMocks();
});

it.each(['revised_hypotheses', 'append_fragments'] as const)(
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
    stream.endInput();
    await reader;
    expect(mock.streams[0]!.audio.map((chunk) => chunk.length)).toEqual([3200, 640]);
    expect(events.map((event) => event.type)).toEqual([0, 1, 1, 2, 4, 3]);
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
  stream.endInput();
  await reader;
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
  stream.endInput();
  await reader;
  expect(mock.streams.map((s) => s.options)).toMatchObject([
    { language: 'en-US', mode: 'written', contextTerms: ['Rime', 'LiveKit'] },
    { language: 'es', mode: 'verbatim', contextTerms: ['new', 'Rime', 'LiveKit'] },
  ]);
});
it('silence does not initialize the SDK or start any request', async () => {
  start();
  await vad();
  stream.pushFrame(frame());
  stream.endInput();
  await reader;
  expect(events).toEqual([]);
  expect(bridge.loadSDK).not.toHaveBeenCalled();
});
it('successful empty transcripts remain finals', async () => {
  mock = provider(async function* (self) {
    for await (const _chunk of self.chunks()) {
      /* silence */
    }
    yield { kind: 'final', text: '', language: 'en' };
  });
  start();
  await utterance();
  stream.endInput();
  await reader;
  expect(events.map((e) => e.type)).toEqual([0, 2, 4, 3]);
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
    stream.endInput();
    await reader;
    expect(events.some((e) => e.type === 2 || e.type === 3 || e.type === 4)).toBe(false);
    expect(mock.streams).toHaveLength(1);
    expect(stream.terminalError).toHaveProperty('retryable', false);
    expect(String(stream.terminalError)).not.toContain('private-provider-content');
  },
);
it('finishes an active utterance at endInput without an END event', async () => {
  start();
  await (await vad()).send(VADEventType.START_OF_SPEECH);
  stream.endInput();
  await reader;
  expect(events.map((e) => e.type)).toEqual([0, 1, 2, 4, 3]);
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
  stream.endInput();
  await reader;
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
    await self.wait(new Promise(() => {}));
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
    await self.wait(new Promise(() => {}));
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
    for await (const _chunk of self.chunks()) {
      /* upload */
    }
    await self.wait(new Promise(() => {}));
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
      for await (const _chunk of self.chunks()) {
        /* upload */
      }
      if (mock.streams.indexOf(self) === failing) {
        await self.wait(release.promise);
        throw new sdk.RimeInputError('private', 'failed-id');
      }
      await self.wait(new Promise(() => {}));
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
it.each(['revised_hypotheses', 'append_fragments'] as const)(
  'uploads later %s utterances before earlier finals and coalesces buffered interims',
  async (contract) => {
    const release = [deferred(), deferred()];
    const uploaded = [deferred(), deferred()];
    mock = provider(async function* (self) {
      const index = mock.streams.indexOf(self);
      for await (const _chunk of self.chunks()) {
        for (let i = 0; i < 50; i++)
          yield self.options.outputContract === 'append_fragments'
            ? { kind: 'delta', text: 'x' }
            : { kind: 'partial', text: `${i}` };
      }
      uploaded[index]!.resolve();
      await self.wait(release[index]!.promise);
      yield { kind: 'final', text: index ? 'second' : 'first', language: 'en' };
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
    expect(
      events.filter((e) => e.type === 0 || e.type === 2 || e.type === 3).map((e) => e.type),
    ).toEqual([0, 2, 3, 0, 2, 3]);
    const second = events.slice(events.map((e) => e.type).lastIndexOf(0));
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
  const release = [deferred(), deferred()];
  const uploaded = [deferred(), deferred()];
  mock = provider(async function* (self) {
    const index = mock.streams.indexOf(self);
    for await (const _chunk of self.chunks()) {
      /* upload */
    }
    uploaded[index]!.resolve();
    await self.wait(release[index]!.promise);
    yield { kind: 'final', text: String(index), language: 'en' };
  });
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
