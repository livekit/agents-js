// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import { initializeLogger, type metrics, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RivaSpeechRecognition } from './proto.js';
import { STT } from './stt.js';

type ProtoRecord = Record<string, unknown>;

type RecognizeCall = grpc.ServerDuplexStream<ProtoRecord, ProtoRecord>;

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = SAMPLE_RATE / 10;

let server: grpc.Server | undefined;
let instance: STT | undefined;
let stream: stt.SpeechStream | undefined;

async function startServer(streamingRecognize: (call: RecognizeCall) => void): Promise<STT> {
  server = new grpc.Server();
  const { service } = RivaSpeechRecognition as unknown as grpc.ServiceClientConstructor;
  server.addService(service, { StreamingRecognize: streamingRecognize });
  const port = await new Promise<number>((resolve, reject) =>
    server!.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  instance = new STT({ server: `127.0.0.1:${port}`, useSsl: false, apiKey: 'test-key' });
  return instance;
}

function frame(): AudioFrame {
  return new AudioFrame(new Int16Array(FRAME_SAMPLES), SAMPLE_RATE, 1, FRAME_SAMPLES);
}

function result(transcript: string, isFinal: boolean, words: ProtoRecord[] = []): ProtoRecord {
  return { results: [{ alternatives: [{ transcript, confidence: 0.9, words }], isFinal }] };
}

async function collect(value: stt.SpeechStream): Promise<stt.SpeechEvent[]> {
  const events: stt.SpeechEvent[] = [];
  for await (const event of value) events.push(event);
  return events;
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

describe('NVIDIA STT', () => {
  it('streams Riva requests, emits transcripts, and reports the audio sent', async () => {
    const requests: ProtoRecord[] = [];
    let audioBytes = 0;
    let metadata: grpc.Metadata | undefined;
    const provider = await startServer((call) => {
      metadata = call.metadata;
      call.on('data', (request: ProtoRecord) => {
        if (request['streamingConfig']) requests.push(request);
        else audioBytes += (request['audioContent'] as Buffer).length;
      });
      call.on('end', () => {
        call.write({ ...result('hello', false), id: { value: 'riva-1' } });
        call.write({
          ...result('hello world', true, [
            { word: 'hello', startTime: 100, endTime: 400 },
            { word: 'world', startTime: 500, endTime: 900 },
          ]),
          id: { value: 'riva-1' },
        });
        call.write(result('next utterance', true));
        call.end();
      });
    });
    const collected: metrics.STTMetrics[] = [];
    provider.on('metrics_collected', (value) => collected.push(value));

    stream = provider.stream({ language: 'fr-FR' });
    // 6.2 s: one usage report at 5 s, the rest when the call ends
    for (let i = 0; i < 62; i++) stream.pushFrame(frame());
    stream.endInput();
    const events = await collect(stream);

    expect(requests).toEqual([
      {
        streamingConfig: {
          config: {
            encoding: 1, // LINEAR_PCM on the wire
            sampleRateHertz: SAMPLE_RATE,
            languageCode: 'fr-FR',
            maxAlternatives: 1,
            audioChannelCount: 1,
            enableWordTimeOffsets: true,
            enableAutomaticPunctuation: true,
            model: 'parakeet-1.1b-en-US-asr-streaming-silero-vad-sortformer',
          },
          interimResults: true,
        },
        streamingRequest: 'streamingConfig',
      },
    ]);
    expect(metadata!.get('authorization')).toEqual([]);
    expect(metadata!.get('function-id')).toEqual([]);
    expect(audioBytes).toBe(62 * FRAME_SAMPLES * 2);

    const speech = events.filter((e) => e.type !== stt.SpeechEventType.RECOGNITION_USAGE);
    expect(speech.map((e) => e.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    expect(speech[2]).toMatchObject({
      requestId: 'riva-1',
      alternatives: [{ text: 'hello world', startTime: 0.1, endTime: 0.9, language: 'fr-FR' }],
    });
    expect(speech[5]!.requestId).not.toBe(speech[2]!.requestId);
    expect(speech[2]!.alternatives![0]!.confidence).toBeCloseTo(0.9);
    expect(collected.map((value) => value.audioDurationMs)).toEqual([5000, 1200]);
  });

  it('starts a fresh utterance on reconnect and keeps timestamps on the stream clock', async () => {
    const calls: { configs: number; frames: number }[] = [];
    const provider = await startServer((call) => {
      const received = { configs: 0, frames: 0 };
      calls.push(received);
      call.on('data', (request: ProtoRecord) => {
        if (request['streamingConfig']) {
          received.configs++;
          return;
        }
        received.frames++;
        if (calls.length === 1) {
          call.write(result('lost', false));
          setTimeout(() => call.emit('error', { code: grpc.status.UNAVAILABLE }), 20);
        }
      });
      call.on('end', () => {
        if (calls.length === 1) return;
        call.write({
          ...result('kept', true, [{ word: 'kept', startTime: 100, endTime: 200 }]),
          id: { value: 'riva-2' },
        });
        call.end();
      });
    });
    const recoverable: boolean[] = [];
    provider.on('error', (error) => recoverable.push(error.recoverable));

    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    stream.pushFrame(frame());
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    for (let i = 0; i < 3; i++) stream.pushFrame(frame());
    stream.endInput();
    const events = await collect(stream);

    // audio sent to the failed call is not replayed into the new one
    expect(calls).toEqual([
      { configs: 1, frames: 1 },
      { configs: 1, frames: 3 },
    ]);
    expect(recoverable).toEqual([]);
    const speech = events.filter((e) => e.type !== stt.SpeechEventType.RECOGNITION_USAGE);
    expect(speech.map((e) => e.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    expect(speech[1]!.requestId).not.toBe(speech[3]!.requestId);
    expect(speech[3]!.requestId).toBe('riva-2');
    expect(speech[3]!.alternatives![0]!.startTime).toBeGreaterThan(0.1);
    const usage = events.filter((e) => e.type === stt.SpeechEventType.RECOGNITION_USAGE);
    expect(usage.map((e) => e.recognitionUsage!.audioDuration)).toEqual([0.1, 0.3]);
  });

  it('cancels the call quietly on close', async () => {
    let cancelled = false;
    let configured = false;
    const provider = await startServer((call) => {
      call.on('data', () => {
        configured = true;
      });
      call.on('cancelled', () => {
        cancelled = true;
      });
    });
    const recoverable: boolean[] = [];
    provider.on('error', (error) => recoverable.push(error.recoverable));

    stream = provider.stream();
    await vi.waitFor(() => expect(configured).toBe(true));
    stream.close();

    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(recoverable).toEqual([]);
  });

  it('reconnects when the server ends recognition before input ends', async () => {
    let calls = 0;
    const provider = await startServer((call) => {
      calls++;
      const first = calls === 1;
      call.on('data', (request: ProtoRecord) => {
        if (first && request['audioContent']) call.end();
      });
      call.on('end', () => {
        if (first) return;
        call.write(result('after reconnect', true));
        call.end();
      });
    });
    provider.on('error', () => {});
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    stream.pushFrame(frame());
    await vi.waitFor(() => expect(calls).toBe(2));
    stream.pushFrame(frame());
    stream.endInput();
    const events = await collect(stream);
    expect(
      events.find((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT),
    ).toMatchObject({
      alternatives: [{ text: 'after reconnect' }],
    });
  });
});
