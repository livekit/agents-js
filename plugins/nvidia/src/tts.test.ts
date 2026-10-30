// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import {
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  type metrics,
  type tts,
} from '@livekit/agents';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RivaSpeechSynthesis } from './proto.js';
import { TTS } from './tts.js';

type ProtoRecord = Record<string, unknown>;

type SynthesizeCall = grpc.ServerWritableStream<ProtoRecord, ProtoRecord>;

let server: grpc.Server | undefined;
let instance: TTS | undefined;
let stream: tts.SynthesizeStream | undefined;

async function startServer(synthesizeOnline: (call: SynthesizeCall) => void): Promise<TTS> {
  server = new grpc.Server();
  const { service } = RivaSpeechSynthesis as unknown as grpc.ServiceClientConstructor;
  server.addService(service, { SynthesizeOnline: synthesizeOnline });
  const port = await new Promise<number>((resolve, reject) =>
    server!.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  instance = new TTS({ server: `127.0.0.1:${port}`, useSsl: false, apiKey: 'test-key' });
  return instance;
}

async function collect(value: tts.SynthesizeStream): Promise<tts.SynthesizedAudio[]> {
  const audio: tts.SynthesizedAudio[] = [];
  for await (const item of value) {
    if (typeof item !== 'symbol') audio.push(item);
  }
  return audio;
}

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(async () => {
  stream?.close();
  await instance?.close();
  instance = undefined;
  stream = undefined;
  server?.forceShutdown();
  server = undefined;
});

describe('NVIDIA TTS', () => {
  it('sends flushed text in one logical segment and reports all text and audio', async () => {
    const requests: ProtoRecord[] = [];
    const metadata: grpc.Metadata[] = [];
    const defaultMaxRetry = DEFAULT_API_CONNECT_OPTIONS.maxRetry;
    const provider = await startServer((call) => {
      requests.push(call.request);
      metadata.push(call.metadata);
      // one full 100 ms frame plus a partial one that only a segment flush emits
      call.write({ audio: Buffer.alloc(1700 * 2, requests.length) });
      call.end();
    });
    const collected: metrics.TTSMetrics[] = [];
    provider.on('metrics_collected', (value) => collected.push(value));

    stream = provider.stream();
    stream.pushText('Hello there.');
    stream.flush();
    stream.pushText('See you later.');
    stream.endInput();
    const audio = await collect(stream);

    expect(requests).toEqual([
      expect.objectContaining({
        text: 'Hello there.',
        languageCode: 'en-US',
        encoding: 1, // LINEAR_PCM on the wire
        sampleRateHz: 16000,
        voiceName: 'Magpie-Multilingual.EN-US.Leo',
      }),
      expect.objectContaining({ text: 'See you later.' }),
    ]);
    expect(metadata[0]!.get('authorization')).toEqual([]);
    expect(metadata[0]!.get('function-id')).toEqual([]);

    expect(new Set(audio.map((item) => item.segmentId)).size).toBe(1);
    expect(audio.map((item) => item.final)).toEqual([false, false, true]);
    expect(audio.map((item) => item.frame.samplesPerChannel)).toEqual([1600, 1600, 200]);
    expect(collected.map((value) => value.charactersCount)).toEqual([26]);
    expect(collected.map((value) => value.audioDurationMs)).toEqual([213]);
    expect(DEFAULT_API_CONNECT_OPTIONS.maxRetry).toBe(defaultMaxRetry);
  });

  it('fails without replaying text the provider already received', async () => {
    let calls = 0;
    const provider = await startServer((call) => {
      calls++;
      call.emit('error', { code: grpc.status.UNAVAILABLE, details: 'unavailable' });
    });
    const recoverable: boolean[] = [];
    provider.on('error', (error) => recoverable.push(error.recoverable));
    const connOptions = { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 1000 };

    stream = provider.stream({ connOptions });
    stream.pushText('Hello there.');
    stream.endInput();
    expect(await collect(stream)).toEqual([]);

    expect(calls).toBe(1);
    expect(recoverable).toEqual([false]);
    expect(connOptions.maxRetry).toBe(3);
  });

  it('preserves audio and continues after a failed sentence', async () => {
    const texts: string[] = [];
    const provider = await startServer((call) => {
      texts.push(call.request['text'] as string);
      if (texts.length === 2) {
        call.emit('error', { code: grpc.status.INTERNAL, details: 'bad sentence' });
      } else {
        call.write({ audio: Buffer.alloc(1600 * 2, texts.length) });
        call.end();
      }
    });
    const errors: unknown[] = [];
    provider.on('error', (error) => errors.push(error));
    stream = provider.stream();
    for (const text of ['First sentence.', 'Second sentence.', 'Third sentence.']) {
      stream.pushText(text);
      stream.flush();
    }
    stream.endInput();
    const audio = await collect(stream);
    expect(texts).toEqual(['First sentence.', 'Second sentence.', 'Third sentence.']);
    expect(audio.map((item) => item.frame.data[0])).toEqual([257, 771]);
    expect(audio.map((item) => item.final)).toEqual([false, true]);
    expect(errors).toEqual([]);
  });

  it('reuses the same connection across synthesis streams', async () => {
    const peers: string[] = [];
    const provider = await startServer((call) => {
      peers.push(call.getPeer());
      call.write({ audio: Buffer.alloc(3200) });
      call.end();
    });
    for (let i = 0; i < 2; i++) {
      stream = provider.stream();
      stream.pushText('Hello there.');
      stream.endInput();
      expect(await collect(stream)).toHaveLength(1);
      stream.close();
    }
    expect(peers).toHaveLength(2);
    expect(peers[0]).toBe(peers[1]);
  });

  it('cancels the active request and skips buffered text on close', async () => {
    const calls: SynthesizeCall[] = [];
    let cancelled = 0;
    const provider = await startServer((call) => {
      calls.push(call);
      call.on('cancelled', () => cancelled++);
    });

    stream = provider.stream();
    stream.pushText('First sentence.');
    stream.flush();
    stream.pushText('Second sentence.');
    stream.endInput();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    stream.close();

    await vi.waitFor(() => expect(cancelled).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toHaveLength(1);
  });
});
