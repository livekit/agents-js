// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import {
  Agent,
  AgentSession,
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  type metrics,
  type tts,
} from '@livekit/agents';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RivaSpeechSynthesis } from './proto.js';
import { TTS, type TTSOptions } from './tts.js';

type ProtoRecord = Record<string, unknown>;

type SynthesizeCall = grpc.ServerWritableStream<ProtoRecord, ProtoRecord>;
type OfflineSynthesizeCall = grpc.ServerUnaryCall<ProtoRecord, ProtoRecord>;

let server: grpc.Server | undefined;
let instance: TTS | undefined;
let stream: tts.SynthesizeStream | undefined;
const sessions: AgentSession[] = [];

async function startServer(
  synthesizeOnline: (call: SynthesizeCall) => void,
  options: Partial<TTSOptions> = {},
  synthesize?: (call: OfflineSynthesizeCall, callback: grpc.sendUnaryData<ProtoRecord>) => void,
  getConfig?: (call: OfflineSynthesizeCall, callback: grpc.sendUnaryData<ProtoRecord>) => void,
): Promise<TTS> {
  server = new grpc.Server();
  const { service } = RivaSpeechSynthesis as unknown as grpc.ServiceClientConstructor;
  server.addService(service, {
    SynthesizeOnline: synthesizeOnline,
    Synthesize:
      synthesize ??
      ((_call: OfflineSynthesizeCall, callback: grpc.sendUnaryData<ProtoRecord>) =>
        callback({ code: grpc.status.UNIMPLEMENTED }, null)),
    GetRivaSynthesisConfig:
      getConfig ??
      ((_call: OfflineSynthesizeCall, callback: grpc.sendUnaryData<ProtoRecord>) =>
        callback(null, { modelConfig: [] })),
  });
  const port = await new Promise<number>((resolve, reject) =>
    server!.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  instance = new TTS({
    server: `127.0.0.1:${port}`,
    useSsl: false,
    apiKey: 'test-key',
    ...options,
  });
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
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await instance?.close();
  instance = undefined;
  stream = undefined;
  server?.forceShutdown();
  server = undefined;
});

describe('NVIDIA TTS', () => {
  it.each([
    ['Magpie-Multilingual.EN-US.Leo', 'Magpie-Multilingual'],
    ['Chatterbox', 'Chatterbox'],
  ])('reports the model family for %s', async (voice, family) => {
    instance = new TTS({ apiKey: 'test', voice });
    expect(instance.model).toBe(family);
  });

  it.each(['online', 'offline'] as const)('supports %s synthesis', async (inferenceMode) => {
    const requests: ProtoRecord[] = [];
    const provider = await startServer(
      (call) => {
        requests.push(call.request);
        call.write({ audio: Buffer.alloc(3200) });
        call.end();
      },
      {
        inferenceMode,
        options: {
          customDictionary: 'LiveKit  live kit',
          customConfiguration: { exaggeration_factor: '0.5' },
        },
      },
      (call, callback) => {
        requests.push(call.request);
        callback(null, { audio: Buffer.alloc(3200) });
      },
    );
    const audio: tts.SynthesizedAudio[] = [];
    for await (const item of provider.synthesize(' hello ')) audio.push(item);
    expect(audio).toHaveLength(1);
    expect(requests).toEqual([
      expect.objectContaining({
        text: 'hello',
        encoding: 1,
        customDictionary: 'LiveKit  live kit',
        customConfiguration: { exaggeration_factor: '0.5' },
      }),
    ]);
  });

  it('normalizes voice listings into individual locale entries without duplicates', async () => {
    const provider = await startServer(
      (call) => call.end(),
      {},
      undefined,
      (_call, callback) =>
        callback(null, {
          modelConfig: [
            {
              modelName: 'magpie',
              parameters: {
                language_code: 'en-US, es-US',
                voice_name: 'Magpie',
                subvoices: 'Leo:male,Leo:male',
              },
            },
          ],
        }),
    );
    await expect(provider.listVoices()).resolves.toEqual({
      'en-US': { voices: ['Magpie.Leo'] },
      'es-US': { voices: ['Magpie.Leo'] },
    });
  });

  it('sends zero-shot prompt audio and quality using the wire protocol', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nvidia-tts-'));
    const prompt = join(directory, 'prompt.wav');
    const pcm = Buffer.alloc(320);
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(pcm.length, 40);
    pcm.copy(wav, 44);
    writeFileSync(prompt, wav);
    try {
      let request: ProtoRecord | undefined;
      const provider = await startServer(
        (call) => {
          request = call.request;
          call.write({ audio: Buffer.alloc(3200) });
          call.end();
        },
        { audioPromptFile: prompt, quality: 30 },
      );
      for await (const _item of provider.synthesize('hello')) {
        // Drain synthesized audio so the request completes.
      }
      expect(request!['zeroShotData']).toMatchObject({
        audioPrompt: pcm,
        sampleRateHz: 16000,
        encoding: 1,
        quality: 30,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('completes after flush while text input remains open', async () => {
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
    const audio = await collect(stream);

    expect(requests).toEqual([
      expect.objectContaining({
        text: 'Hello there.',
        languageCode: 'en-US',
        encoding: 1, // LINEAR_PCM on the wire
        sampleRateHz: 16000,
        voiceName: 'Magpie-Multilingual.EN-US.Leo',
      }),
    ]);
    expect(metadata[0]!.get('authorization')).toEqual([]);
    expect(metadata[0]!.get('function-id')).toEqual([]);

    expect(new Set(audio.map((item) => item.segmentId)).size).toBe(1);
    expect(audio.map((item) => item.final)).toEqual([false, true]);
    expect(audio.map((item) => item.frame.samplesPerChannel)).toEqual([1600, 100]);
    expect(collected.map((value) => value.charactersCount)).toEqual([12]);
    expect(collected.map((value) => value.audioDurationMs)).toEqual([106]);
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

  it('preserves audio and stops after a failed sentence', async () => {
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
    stream.pushText('First sentence. Second sentence. Third sentence.');
    stream.endInput();
    const audio = await collect(stream);
    expect(texts).toEqual(['First sentence. Second sentence.', 'Third sentence.']);
    expect(audio.map((item) => item.frame.data[0])).toEqual([257]);
    expect(errors).toMatchObject([{ recoverable: false }]);
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

  it('releases a shared channel only when the last session closes', async () => {
    const peers: string[] = [];
    const provider = await startServer((call) => {
      peers.push(call.getPeer());
      call.write({ audio: Buffer.alloc(3200) });
      call.end();
    });
    const first = new AgentSession({ tts: provider });
    const second = new AgentSession({ tts: provider });
    sessions.push(first, second);
    await first.start({ agent: Agent.create({ instructions: 'test' }) });
    await second.start({ agent: Agent.create({ instructions: 'test' }) });
    const synthesize = async () => {
      stream = provider.stream();
      stream.pushText('Hello there.');
      stream.endInput();
      expect(await collect(stream)).toHaveLength(1);
    };

    await synthesize();
    await first.close();
    await synthesize();
    expect(peers[0]).toBe(peers[1]);
    await second.close();
    await synthesize();
    expect(peers[2]).not.toBe(peers[1]);
  });

  it('keeps active synthesis alive during idle release and retires its channel afterwards', async () => {
    const calls: SynthesizeCall[] = [];
    const provider = await startServer((call) => calls.push(call));
    stream = provider.stream();
    stream.pushText('Hello there.');
    stream.endInput();
    const audio = collect(stream);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const firstPeer = calls[0]!.getPeer();
    await provider.releaseIdleConnections();
    calls[0]!.write({ audio: Buffer.alloc(3200) });
    calls[0]!.end();
    expect(await audio).toHaveLength(1);

    stream = provider.stream();
    stream.pushText('Another sentence.');
    stream.endInput();
    const nextAudio = collect(stream);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.getPeer()).not.toBe(firstPeer);
    calls[1]!.write({ audio: Buffer.alloc(3200) });
    calls[1]!.end();
    expect(await nextAudio).toHaveLength(1);
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

  it('reports pending text and cancelled usage when interrupted before endInput', async () => {
    let cancelled = false;
    const provider = await startServer((call) => {
      call.on('cancelled', () => {
        cancelled = true;
      });
      call.write({ audio: Buffer.alloc(1600 * 6 * 2) });
    });
    const collected: metrics.TTSMetrics[] = [];
    provider.on('metrics_collected', (value) => collected.push(value));
    const text = 'This sentence is long enough to start speaking.';
    stream = provider.stream();
    stream.pushText(text);
    stream.flush();
    expect((await stream.next()).done).toBe(false);
    stream.close();

    await vi.waitFor(() => expect(cancelled).toBe(true));
    await vi.waitFor(() => expect(collected).toHaveLength(1));
    expect(collected[0]).toMatchObject({ charactersCount: text.length, cancelled: true });
  });

  it('does not send text for a chunked request that was already aborted', async () => {
    let calls = 0;
    const provider = await startServer((call) => {
      calls++;
      call.write({ audio: Buffer.alloc(3200) });
      call.end();
    });
    const controller = new AbortController();
    controller.abort();

    const audio: tts.SynthesizedAudio[] = [];
    for await (const item of provider.synthesize('Hello there.', undefined, controller.signal)) {
      audio.push(item);
    }

    expect(calls).toBe(0);
    expect(audio).toEqual([]);
  });

  it('synthesizes complete text in one request', async () => {
    const first = 'This is the first sentence of the reply.';
    const second = 'This is the second sentence of the reply.';
    const texts: string[] = [];
    const provider = await startServer((call) => {
      texts.push(call.request['text'] as string);
      call.write({ audio: Buffer.alloc(1700 * 2, texts.length) });
      call.end();
    });
    const collected: metrics.TTSMetrics[] = [];
    provider.on('metrics_collected', (value) => collected.push(value));

    const audio: tts.SynthesizedAudio[] = [];
    for await (const item of provider.synthesize(`${first} ${second}`)) audio.push(item);

    expect(texts).toEqual([`${first} ${second}`]);
    expect(new Set(audio.map((item) => item.requestId)).size).toBe(1);
    expect(audio.map((item) => item.frame.samplesPerChannel)).toEqual([1600, 100]);
    expect(audio.map((item) => item.final)).toEqual([false, true]);
    expect(collected.map((value) => value.audioDurationMs)).toEqual([106]);
  });

  it('retries a chunked request only when no audio was produced', async () => {
    let calls = 0;
    const provider = await startServer((call) => {
      calls++;
      if (calls === 1) {
        call.emit('error', { code: grpc.status.UNAVAILABLE, details: 'unavailable' });
        return;
      }
      call.write({ audio: Buffer.alloc(3200) });
      call.end();
    });
    const errors: unknown[] = [];
    provider.on('error', (error) => errors.push(error));
    const connOptions = { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 };

    const audio: tts.SynthesizedAudio[] = [];
    for await (const item of provider.synthesize('Hello there.', connOptions)) audio.push(item);

    expect(calls).toBe(2);
    expect(audio).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('does not retry a chunked request rejected by the provider', async () => {
    let calls = 0;
    const provider = await startServer((call) => {
      calls++;
      call.emit('error', { code: grpc.status.UNAUTHENTICATED, details: 'bad key' });
    });
    const errors: { recoverable: boolean; error: Error }[] = [];
    provider.on('error', (error) => errors.push(error));
    const connOptions = { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 1000 };

    const audio: tts.SynthesizedAudio[] = [];
    for await (const item of provider.synthesize('Hello there.', connOptions)) audio.push(item);

    expect(calls).toBe(1);
    expect(audio).toEqual([]);
    expect(errors).toMatchObject([{ recoverable: false }]);
    expect(errors[0]!.error.message).toContain('bad key');
  });
});
