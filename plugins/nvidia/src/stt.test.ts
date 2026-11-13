// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import { initializeLogger, type metrics, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RivaSpeechRecognition } from './proto.js';
import { STT, type STTOptions } from './stt.js';

type ProtoRecord = Record<string, unknown>;

type RecognizeCall = grpc.ServerDuplexStream<ProtoRecord, ProtoRecord>;

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = SAMPLE_RATE / 10;

let server: grpc.Server | undefined;
let instance: STT | undefined;
let stream: stt.SpeechStream | undefined;

async function startServer(
  streamingRecognize: (call: RecognizeCall) => void,
  options: Partial<STTOptions> = {},
): Promise<STT> {
  server = new grpc.Server();
  const { service } = RivaSpeechRecognition as unknown as grpc.ServiceClientConstructor;
  server.addService(service, { StreamingRecognize: streamingRecognize });
  const port = await new Promise<number>((resolve, reject) =>
    server!.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  instance = new STT({
    server: `127.0.0.1:${port}`,
    useSsl: false,
    apiKey: 'test-key',
    ...options,
  });
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
            diarizationConfig: null, // not sent unless diarization is enabled
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
      alternatives: [
        {
          text: 'hello world',
          startTime: 0.1,
          endTime: 0.9,
          language: 'fr-FR',
          words: [
            { text: 'hello', startTime: 0.1, endTime: 0.4 },
            { text: 'world', startTime: 0.5, endTime: 0.9 },
          ],
        },
      ],
    });
    expect(speech[2]!.alternatives![0]!.speakerId).toBeUndefined();
    expect(speech[5]!.alternatives![0]!.words).toBeUndefined();
    expect(provider.capabilities).toMatchObject({ alignedTranscript: 'word', diarization: false });
    expect(speech[5]!.requestId).not.toBe(speech[2]!.requestId);
    expect(speech[2]!.alternatives![0]!.confidence).toBeCloseTo(0.9);
    expect(collected.map((value) => value.audioDurationMs)).toEqual([5000, 1200]);
  });

  it('continues the open utterance across a reconnect and keeps the stream clock', async () => {
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
    // as in the Python plugin, the next call's final closes the utterance the failed call opened
    expect(speech.map((e) => e.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    expect(speech[2]!.requestId).toBe('riva-2');
    expect(speech[2]!.alternatives![0]!.startTime).toBeGreaterThan(0.1);
    const usage = events.filter((e) => e.type === stt.SpeechEventType.RECOGNITION_USAGE);
    expect(usage.map((e) => e.recognitionUsage!.audioDuration)).toEqual([0.1, 0.3]);
  });

  it('does not retry authorization failures', async () => {
    let calls = 0;
    const provider = await startServer((call) => {
      calls++;
      call.emit('error', { code: grpc.status.PERMISSION_DENIED, details: 'authorization failed' });
    });
    const errors: boolean[] = [];
    provider.on('error', (error) => errors.push(error.recoverable));
    stream = provider.stream({ connOptions: { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 1000 } });
    stream.pushFrame(frame());
    stream.endInput();
    await collect(stream);
    expect(calls).toBe(1);
    expect(errors).toEqual([false]);
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

  it('requests diarization and labels finals with the dominant speaker', async () => {
    let config: ProtoRecord | undefined;
    const provider = await startServer(
      (call) => {
        call.on('data', (request: ProtoRecord) => {
          if (request['streamingConfig']) config = request['streamingConfig'] as ProtoRecord;
        });
        call.on('end', () => {
          const words = [
            { word: 'a', startTime: 0, endTime: 100, speakerTag: 2 },
            { word: 'b', startTime: 100, endTime: 200, speakerTag: 1 },
            { word: 'c', startTime: 200, endTime: 300, speakerTag: 2 },
            { word: 'd', startTime: 300, endTime: 400, speakerTag: 0 },
          ];
          call.write(result('a b c d', false, words));
          call.write(result('a b c d', true, words));
          call.end();
        });
      },
      { enableDiarization: true, maxSpeakerCount: 3 },
    );

    stream = provider.stream();
    stream.pushFrame(frame());
    stream.endInput();
    const events = await collect(stream);

    expect(provider.capabilities.diarization).toBe(true);
    expect((config!['config'] as ProtoRecord)['diarizationConfig']).toEqual({
      enableSpeakerDiarization: true,
      maxSpeakerCount: 3,
    });
    const transcripts = events.filter(
      (e) =>
        e.type === stt.SpeechEventType.INTERIM_TRANSCRIPT ||
        e.type === stt.SpeechEventType.FINAL_TRANSCRIPT,
    );
    // only finals carry a speaker, as in the Python plugin
    expect(transcripts.map((e) => e.alternatives![0]!.speakerId)).toEqual([undefined, 'S2']);
    for (const event of transcripts) {
      expect(event.alternatives![0]!.words!.map((word) => word.speakerId)).toEqual([
        'S2',
        'S1',
        'S2',
        null,
      ]);
    }
  });

  it('counts results without a transcript as provider progress', async () => {
    let calls = 0;
    const provider = await startServer((call) => {
      calls++;
      const attempt = calls;
      call.on('data', (request: ProtoRecord) => {
        if (!request['audioContent']) return;
        // a result with an empty transcript proves the provider is alive
        call.write(result('', false));
        if (attempt < 3) setTimeout(() => call.emit('error', { code: grpc.status.UNAVAILABLE }), 5);
      });
      call.on('end', () => {
        call.write(result('done', true));
        call.end();
      });
    });
    const errors: boolean[] = [];
    provider.on('error', (error) => errors.push(error.recoverable));

    // two failures with maxRetry 1 survive only if each attempt's progress resets the budget
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    stream.pushFrame(frame());
    await vi.waitFor(() => expect(calls).toBe(2));
    stream.pushFrame(frame());
    await vi.waitFor(() => expect(calls).toBe(3));
    stream.pushFrame(frame());
    stream.endInput();
    const events = await collect(stream);

    expect(errors).toEqual([]);
    expect(events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)).toMatchObject({
      alternatives: [{ text: 'done' }],
    });
  });

  it('sends whole frames when the sample rate is not a multiple of 10', async () => {
    let audioBytes = 0;
    const provider = await startServer(
      (call) => {
        call.on('data', (request: ProtoRecord) => {
          if (request['audioContent']) audioBytes += (request['audioContent'] as Buffer).length;
        });
        call.on('end', () => call.end());
      },
      { sampleRate: 11025 },
    );
    const errors: unknown[] = [];
    provider.on('error', (error) => errors.push(error));

    stream = provider.stream();
    stream.pushFrame(new AudioFrame(new Int16Array(11025), 11025, 1, 11025));
    stream.endInput();
    await collect(stream);

    expect(errors).toEqual([]);
    expect(audioBytes).toBe(11025 * 2);
  });
});
