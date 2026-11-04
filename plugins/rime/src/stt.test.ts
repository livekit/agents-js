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
        endInput: () => events.close(),
        close: () => events.close(),
      }),
    } as unknown as VAD,
    emit(type: VADEventType, frames: AudioFrame[] = []) {
      events.push({ type, frames, timestamp: Date.now(), silenceDuration: 0 } as VADEvent);
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
