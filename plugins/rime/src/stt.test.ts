// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  stt,
} from '@livekit/agents';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STT } from './stt.js';
import { toWav } from './stt_audio.js';
import * as bridge from './stt_sdk.js';
import { Detector, collect, deferred, frame, provider, sdk } from './stt_test_helpers.js';

let mock: ReturnType<typeof provider>;
const owners: STT[] = [];
function owner(options: ConstructorParameters<typeof STT>[0] = {}) {
  const value = new STT({
    apiKey: 'test-key',
    connOptions: { maxRetry: 0, timeoutMs: 2000 },
    ...options,
  });
  owners.push(value);
  return value;
}
beforeEach(() => {
  mock = provider();
  vi.spyOn(bridge, 'loadSDK').mockImplementation(async () => mock.module);
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((value) => value.close()));
  vi.restoreAllMocks();
});

it.each([
  [16000, 1],
  [48000, 1],
  [48000, 2],
  [44100, 2],
])(
  'converts %i Hz/%i channels to complete WAV, flushes resampling, and maps metrics',
  async (rate, channels) => {
    const value = owner();
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
  const value = owner({
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
  const value = owner();
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
    await expect(owner().recognize(audio)).rejects.toMatchObject({ retryable: false });
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
    expect(() => owner({ contextTerms: contextTerms as unknown as string[] })).toThrow(
      'array of strings',
    );
    expect(() =>
      owner().updateOptions({ contextTerms: contextTerms as unknown as string[] }),
    ).toThrow('array of strings');
  },
);
it('validates contract, connection configuration and native VAD requirements', () => {
  expect(() => owner({ outputContract: 'append_fragments' })).toThrow('requires a vad');
  expect(() => owner({ outputContract: 'bad' as 'append_fragments' })).toThrow('Unsupported');
  expect(() => owner({ connOptions: { timeoutMs: 0 } })).toThrow('connection options');
  expect(() => owner().stream()).toThrow('Pass vad');
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
    const value = owner();
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
    await bridge.abortable(new Promise<never>(() => {}), options.signal);
    throw new Error('unreachable');
  });
  const value = owner({
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
  await expect(owner().recognize(frame())).rejects.toThrow('Install @rimelabs/sdk');
  const gate = deferred<bridge.SDK>();
  vi.mocked(bridge.loadSDK).mockReturnValueOnce(gate.promise);
  const value = owner();
  const request = value.recognize(frame());
  const assertion = expect(request).rejects.toThrow('cancelled');
  const closing = value.close();
  gate.resolve(mock.module);
  await closing;
  await assertion;
  expect(mock.client.close).toHaveBeenCalledOnce();
});

it('supports the real StreamAdapter and preserves caller-owned VAD', async () => {
  const detector = new Detector();
  const value = owner();
  const adapter = new stt.StreamAdapter(value, detector);
  const stream = adapter.stream();
  const result = collect(stream);
  await detector.streams[0]!.send(0);
  await detector.streams[0]!.send(2);
  await vi.waitFor(() => expect(mock.client.stt.transcribe).toHaveBeenCalledOnce());
  stream.endInput();
  expect((await result).some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toBe(true);
  stream.close();
  await value.close();
  expect(detector.close).not.toHaveBeenCalled();
});
