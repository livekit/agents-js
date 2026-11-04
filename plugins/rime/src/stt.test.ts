// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type VAD, type VADEvent, VADEventType, initializeLogger, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import type * as r from '@rimelabs/sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { STT } from './stt.js';

initializeLogger({ pretty: false, level: 'silent' });
const owners: STT[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
});
const frame = (channels = 1, sampleRate = 16000) =>
  new AudioFrame(new Int16Array(320 * channels).fill(100), sampleRate, channels, 320);
function model(client: object, options: Partial<ConstructorParameters<typeof STT>[0]> = {}) {
  const owner = new STT({ client: client as r.Rime, ...options });
  owner.on('error', () => undefined);
  owners.push(owner);
  return owner;
}
class Queue<T> implements AsyncIterable<T> {
  values: T[] = [];
  ended = false;
  wake?: () => void;
  push(value: T) {
    this.values.push(value);
    this.wake?.();
  }
  close() {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.values.length) yield this.values.shift()!;
      else if (this.ended) return;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
function detector() {
  const events = new Queue<VADEvent>();
  return {
    events,
    vad: {
      stream: () => ({
        [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        pushFrame: vi.fn(),
        flush: vi.fn(),
        endInput: () => events.close(),
        close: () => events.close(),
      }),
    } as unknown as VAD,
    emit(type: VADEventType, frames: AudioFrame[] = []) {
      events.push({ type, frames, timestamp: 37, silenceDuration: 0 } as VADEvent);
    },
  };
}
function streamingClient() {
  const updates: Queue<r.TranscriptionUpdate>[] = [];
  const uploads: Uint8Array[][] = [];
  const cancel = vi.fn(async () => undefined);
  const stream = vi.fn((source: AsyncIterable<Uint8Array>) => {
    const queue = new Queue<r.TranscriptionUpdate>();
    const chunks: Uint8Array[] = [];
    uploads.push(chunks);
    updates.push(queue);
    void (async () => {
      for await (const chunk of source) chunks.push(chunk);
    })();
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      requestId: 'test-request',
      cancel: async () => {
        queue.close();
        await cancel();
      },
    };
  });
  return { client: { stt: { stream }, close: vi.fn() }, stream, updates, uploads, cancel };
}
it('transcribes a downmixed recording and snapshots language and keyterms', async () => {
  const transcribe = vi.fn(async () => ({
    text: 'confirmed words',
    language: 'en',
    requestId: 'recording',
  }));
  const client = { stt: { transcribe }, close: vi.fn() };
  const terms = ['Rime'];
  const owner = model(client, { contextTerms: terms });
  terms.push('mutated');
  owner._updateSessionKeyterms(['Rime', 'Prism']);
  const result = await owner.recognize(frame(2, 24000));
  expect(result.alternatives?.[0]?.text).toBe('confirmed words');
  expect(owner.capabilities.streaming).toBe(false);
  const [audio, options] = transcribe.mock.calls[0] as unknown as [Buffer, Record<string, unknown>];
  expect(Buffer.from(audio).readUInt32LE(24)).toBe(16000);
  expect(Buffer.from(audio).readUInt16LE(22)).toBe(1);
  expect(options).toMatchObject({ language: 'en', contextTerms: ['Rime', 'Prism'] });
  await owner.close();
  expect(client.close).not.toHaveBeenCalled();
});
it('rejects unsupported streaming and mixed recording formats', async () => {
  const transcribe = vi.fn();
  const owner = model({ stt: { transcribe } });
  expect(() => owner.stream()).toThrow('VAD');
  await expect(owner.recognize([frame(), frame(2)])).rejects.toThrow('Mixed');
  expect(transcribe).not.toHaveBeenCalled();
});
it('retries only whole-recording transport failures', async () => {
  const sdk = await import('@rimelabs/sdk');
  const transcribe = vi
    .fn()
    .mockRejectedValueOnce(new sdk.RimeUnavailableError('unavailable'))
    .mockResolvedValue({ text: 'done', language: 'en' });
  const owner = model({ stt: { transcribe } }, { connOptions: { maxRetry: 1 } });
  expect((await owner.recognize(frame())).alternatives?.[0]?.text).toBe('done');
  expect(transcribe).toHaveBeenCalledTimes(2);
});
it('preserves append whitespace and publishes completed utterances in VAD order', async () => {
  const d = detector(),
    api = streamingClient();
  const owner = model(api.client, { vad: d.vad, outputContract: 'append_fragments' });
  const stream = owner.stream();
  const events: stt.SpeechEvent[] = [];
  const reading = (async () => {
    for await (const event of stream) events.push(event);
  })();
  d.emit(VADEventType.START_OF_SPEECH, [frame()]);
  d.emit(VADEventType.END_OF_SPEECH);
  owner.updateOptions({ contextTerms: ['next'] });
  d.emit(VADEventType.START_OF_SPEECH, [frame()]);
  d.emit(VADEventType.END_OF_SPEECH);
  await vi.waitFor(() => expect(api.stream).toHaveBeenCalledTimes(2));
  api.updates[1]!.push({ kind: 'final', text: 'Second', language: 'en' } as r.TranscriptionUpdate);
  api.updates[1]!.close();
  api.updates[0]!.push({ kind: 'delta', text: ' Hello' } as r.TranscriptionUpdate);
  await vi.waitFor(() =>
    expect(events.some((e) => e.alternatives?.[0]?.text === ' Hello')).toBe(true),
  );
  api.updates[0]!.push({ kind: 'delta', text: ' world ' } as r.TranscriptionUpdate);
  await vi.waitFor(() =>
    expect(events.some((e) => e.alternatives?.[0]?.text === ' Hello world ')).toBe(true),
  );
  api.updates[0]!.push({
    kind: 'final',
    text: 'Hello world.',
    language: 'en',
  } as r.TranscriptionUpdate);
  api.updates[0]!.close();
  stream.endInput();
  await reading;
  expect(
    events
      .filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)
      .map((e) => e.alternatives?.[0]?.text),
  ).toEqual(['Hello world.', 'Second']);
  expect(api.uploads.map((chunks) => chunks.reduce((n, c) => n + c.length, 0))).toEqual([640, 640]);
  expect(api.cancel).toHaveBeenCalledTimes(2);
});
it('never promotes an unconfirmed interim and does not replay streaming audio', async () => {
  const d = detector(),
    api = streamingClient();
  const owner = model(api.client, { vad: d.vad });
  const errors: unknown[] = [];
  owner.on('error', (e) => errors.push(e));
  const stream = owner.stream();
  const events: stt.SpeechEvent[] = [];
  const reading = (async () => {
    for await (const event of stream) events.push(event);
  })();
  d.emit(VADEventType.START_OF_SPEECH, [frame()]);
  d.emit(VADEventType.END_OF_SPEECH);
  await vi.waitFor(() => expect(api.stream).toHaveBeenCalledOnce());
  api.updates[0]!.push({ kind: 'partial', text: 'unfinished' } as r.TranscriptionUpdate);
  api.updates[0]!.close();
  stream.endInput();
  await reading;
  expect(events.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(api.stream).toHaveBeenCalledOnce();
});
it('closes immediately created streams without closing the caller VAD', async () => {
  const d = detector();
  const owner = model(streamingClient().client, { vad: d.vad });
  const stream = owner.stream();
  stream.close();
  await owner.close();
});

it.each(['audio', 'utterances'] as const)(
  'reports %s overflow once and cancels requests without replay',
  async (limit) => {
    const d = detector();
    const cancel = vi.fn(async () => undefined);
    const start = vi.fn((_source: AsyncIterable<Uint8Array>, options: r.TranscriptionOptions) => {
      const events = new Queue<r.TranscriptionUpdate>();
      if (options.signal?.aborted) events.close();
      else options.signal?.addEventListener('abort', () => events.close(), { once: true });
      return { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), cancel };
    });
    const owner = model({ stt: { stream: start } }, { vad: d.vad });
    const errors: unknown[] = [];
    owner.on('error', (error) => errors.push(error));
    const stream = owner.stream();
    const events: stt.SpeechEvent[] = [];
    const reading = (async () => {
      for await (const event of stream) events.push(event);
    })();
    if (limit === 'audio')
      d.emit(VADEventType.START_OF_SPEECH, [
        new AudioFrame(new Int16Array(160001), 16000, 1, 160001),
      ]);
    else
      for (let i = 0; i < 9; i++) {
        d.emit(VADEventType.START_OF_SPEECH, [frame()]);
        d.emit(VADEventType.END_OF_SPEECH);
      }
    await reading;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ recoverable: false, error: { retryable: false } });
    expect(events.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toEqual([]);
    expect(start).toHaveBeenCalledTimes(limit === 'audio' ? 1 : 8);
    expect(cancel).toHaveBeenCalledTimes(start.mock.calls.length);
    await owner.close();
  },
);
it('uses wall-clock speech times even when VAD timestamps are stream-relative', async () => {
  const d = detector(),
    api = streamingClient();
  const owner = model(api.client, { vad: d.vad });
  const before = Date.now();
  const stream = owner.stream();
  const events: stt.SpeechEvent[] = [];
  const reading = (async () => {
    for await (const event of stream) events.push(event);
  })();
  d.emit(VADEventType.START_OF_SPEECH, [frame()]);
  d.emit(VADEventType.END_OF_SPEECH);
  await vi.waitFor(() => expect(api.stream).toHaveBeenCalledOnce());
  api.updates[0]!.push({ kind: 'final', text: 'done', language: 'en' });
  api.updates[0]!.close();
  stream.endInput();
  await reading;
  expect(
    events.find((e) => e.type === stt.SpeechEventType.START_OF_SPEECH)?.createdAt,
  ).toBeGreaterThanOrEqual(before);
  expect(
    events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)?.speechEndTime,
  ).toBeGreaterThanOrEqual(before);
});

it('snapshots client ownership before loading the SDK', async () => {
  const first = {
    stt: { transcribe: vi.fn(async () => ({ text: 'first', language: 'en' })) },
    close: vi.fn(),
  };
  const second = { stt: { transcribe: vi.fn() }, close: vi.fn() };
  const options = { client: first as unknown as r.Rime };
  const owner = new STT(options);
  owners.push(owner);
  options.client = second as unknown as r.Rime;
  const result = await owner.recognize(frame());
  expect(result.alternatives?.[0]?.text).toBe('first');
  expect(second.stt.transcribe).not.toHaveBeenCalled();
  await owner.close();
  expect(first.close).not.toHaveBeenCalled();
  expect(second.close).not.toHaveBeenCalled();
});

it('drains a last speech-start window and reuses the detector across flushes', async () => {
  const events = new Queue<VADEvent>();
  let pending = 0,
    speaking = false;
  const endInput = vi.fn(() => {
    throw new Error('endInput is unavailable');
  });
  const flush = vi.fn(() => {
    pending = 0;
    speaking = false;
  });
  const detector = {
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    pushFrame(input: AudioFrame) {
      pending += input.samplesPerChannel;
      if (pending >= 320) {
        pending -= 320;
        events.push({
          type: VADEventType.INFERENCE_DONE,
          frames: [frame()],
          timestamp: 20,
        } as VADEvent);
        if (!speaking) {
          speaking = true;
          events.push({
            type: VADEventType.START_OF_SPEECH,
            frames: [frame()],
            timestamp: 20,
          } as VADEvent);
        }
      }
    },
    endInput,
    flush,
    close: () => events.close(),
  };
  const vad = { capabilities: { updateInterval: 20 }, stream: vi.fn(() => detector) };
  const uploads: number[] = [];
  const streamRequest = vi.fn((source: AsyncIterable<Uint8Array>) => ({
    async *[Symbol.asyncIterator]() {
      let bytes = 0;
      for await (const chunk of source) bytes += chunk.length;
      uploads.push(bytes);
      yield { kind: 'final', text: 'confirmed', language: 'en' };
    },
    cancel: async () => undefined,
  }));
  const owner = model({ stt: { stream: streamRequest } }, { vad: vad as unknown as VAD });
  const stream = owner.stream();
  const output: stt.SpeechEvent[] = [];
  const reading = (async () => {
    for await (const event of stream) output.push(event);
  })();
  stream.pushFrame(new AudioFrame(new Int16Array(175), 16000, 1, 175));
  stream.flush();
  stream.pushFrame(new AudioFrame(new Int16Array(160), 16000, 1, 160));
  stream.endInput();
  await reading;
  expect(endInput).not.toHaveBeenCalled();
  expect(vad.stream).toHaveBeenCalledOnce();
  expect(flush).toHaveBeenCalledTimes(2);
  expect(uploads).toEqual([640, 640]);
  expect(output.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toHaveLength(2);
});

it('drains queued final-window speech events through the real VAD stream interface', async () => {
  const { VADStream } = await import('@livekit/agents');
  const end = vi.fn();
  class Detector extends VADStream {
    constructor(vad: VAD) {
      super(vad);
      void this.process();
    }
    private async process() {
      let pending = 0,
        speaking = false;
      while (!this.closed) {
        const { done, value } = await this.inputReader.read();
        if (done) return;
        if (typeof value === 'symbol') {
          pending = 0;
          speaking = false;
          continue;
        }
        pending += value.samplesPerChannel;
        if (pending < 320) continue;
        pending -= 320;
        this.sendVADEvent({
          type: VADEventType.INFERENCE_DONE,
          frames: [frame()],
          timestamp: 20,
        } as VADEvent);
        if (!speaking) {
          speaking = true;
          this.sendVADEvent({
            type: VADEventType.START_OF_SPEECH,
            frames: [frame()],
            timestamp: 20,
          } as VADEvent);
        }
      }
    }
    override endInput() {
      end();
      throw new Error('Do not close the locked VAD writer');
    }
  }
  const vad = {
    capabilities: { updateInterval: 20 },
    stream: vi.fn(() => new Detector(vad as unknown as VAD)),
  };
  const uploadBytes: number[] = [];
  const owner = model(
    {
      stt: {
        stream: (source: AsyncIterable<Uint8Array>) => ({
          async *[Symbol.asyncIterator]() {
            let count = 0;
            for await (const chunk of source) count += chunk.length;
            uploadBytes.push(count);
            yield { kind: 'final', text: 'confirmed', language: 'en' };
          },
          cancel: async () => undefined,
        }),
      },
    },
    { vad: vad as unknown as VAD },
  );
  const stream = owner.stream();
  const output: stt.SpeechEvent[] = [];
  const read = (async () => {
    for await (const event of stream) output.push(event);
  })();
  stream.pushFrame(new AudioFrame(new Int16Array(175), 16000, 1, 175));
  stream.flush();
  stream.pushFrame(new AudioFrame(new Int16Array(160), 16000, 1, 160));
  stream.endInput();
  await read;
  expect(end).not.toHaveBeenCalled();
  expect(vad.stream).toHaveBeenCalledOnce();
  expect(uploadBytes).toEqual([640, 640]);
  expect(output.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toHaveLength(2);
});
