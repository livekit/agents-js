// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind } from '@livekit/rtc-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { setTracerProvider } from '../telemetry/index.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import { AudioRecognition, type _TurnDetector } from './audio_recognition.js';

function setupInMemoryTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  setTracerProvider(provider);
  return { exporter };
}

function spanByName(spans: any[], name: string) {
  return spans.find((s) => s.name === name);
}

class FakeVADStream extends (Object as unknown as { new (): VADStream }) {
  // We intentionally avoid extending the real VADStream (it is not exported as a value in JS output
  // in some bundling contexts). Instead we emulate the async iterator shape used by AudioRecognition.
  private events: VADEvent[];
  private idx = 0;
  constructor(events: VADEvent[]) {
    super();
    this.events = events;
  }
  updateInputStream() {}
  detachInputStream() {}
  close() {}
  [Symbol.asyncIterator]() {
    return this;
  }
  async next(): Promise<IteratorResult<VADEvent>> {
    if (this.idx >= this.events.length) {
      return { done: true, value: undefined };
    }
    const value = this.events[this.idx++]!;
    return { done: false, value };
  }
}

class FakeVAD extends VAD {
  label = 'fake-vad';
  private events: VADEvent[];
  constructor(events: VADEvent[]) {
    super({ updateInterval: 1 });
    this.events = events;
  }
  stream(): any {
    return new FakeVADStream(this.events);
  }
}

const alwaysTrueTurnDetector: _TurnDetector = {
  supportsLanguage: async () => true,
  unlikelyThreshold: async () => undefined,
  predictEndOfTurn: async () => 1.0,
};

describe('AudioRecognition user_turn span parity', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('creates user_turn and parents eou_detection under it (stt mode)', async () => {
    const { exporter } = setupInMemoryTracing();

    const hooks = {
      onStartOfSpeech: vi.fn(),
      onVADInferenceDone: vi.fn(),
      onEndOfSpeech: vi.fn(),
      onInterimTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onPreemptiveGeneration: vi.fn(),
      retrieveChatCtx: () =>
        ({
          copy() {
            return this;
          },
          addMessage() {},
          toJSON() {
            return { items: [] };
          },
        }) as any,
      onEndOfTurn: vi.fn(async () => true),
    };

    const sttEvents: SpeechEvent[] = [
      { type: SpeechEventType.START_OF_SPEECH },
      {
        type: SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            language: 'en',
            text: 'hello',
            startTime: 0,
            endTime: 0,
            confidence: 0.9,
          },
        ],
      },
      { type: SpeechEventType.END_OF_SPEECH },
    ];

    const sttNode = async () =>
      new ReadableStream<SpeechEvent>({
        start(controller) {
          for (const ev of sttEvents) controller.enqueue(ev);
          controller.close();
        },
      });

    const ar = new AudioRecognition({
      recognitionHooks: hooks as any,
      stt: sttNode as any,
      vad: undefined,
      turnDetector: alwaysTrueTurnDetector,
      turnDetectionMode: 'stt',
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
      sttModel: 'deepgram-nova2',
      sttProvider: 'deepgram',
      getLinkedParticipant: () => ({ sid: 'p1', identity: 'bob', kind: ParticipantKind.AGENT }),
    });

    await ar.start();
    // allow background task to drain
    await new Promise((r) => setTimeout(r, 20));
    await ar.close();

    const spans = exporter.getFinishedSpans();
    const userTurn = spanByName(spans, 'user_turn');
    const eou = spanByName(spans, 'eou_detection');
    expect(userTurn, 'user_turn span missing').toBeTruthy();
    expect(eou, 'eou_detection span missing').toBeTruthy();

    expect(eou.parentSpanId).toBe(userTurn.spanContext().spanId);

    // creation-time attributes
    expect(userTurn.attributes['lk.participant_id']).toBe('p1');
    expect(userTurn.attributes['lk.participant_identity']).toBe('bob');
    expect(userTurn.attributes['lk.participant_kind']).toBe('INGRESS');
    expect(userTurn.attributes['gen_ai.request.model']).toBe('deepgram-nova2');
    expect(userTurn.attributes['gen_ai.provider.name']).toBe('deepgram');

    // end-of-turn attributes
    expect(userTurn.attributes['lk.user_transcript']).toContain('hello');
    expect(userTurn.attributes['lk.transcript_confidence']).toBeGreaterThan(0);
  });

  it('creates user_turn from VAD startTime (vad mode) and keeps same parenting', async () => {
    const { exporter } = setupInMemoryTracing();

    const hooks = {
      onStartOfSpeech: vi.fn(),
      onVADInferenceDone: vi.fn(),
      onEndOfSpeech: vi.fn(),
      onInterimTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onPreemptiveGeneration: vi.fn(),
      retrieveChatCtx: () =>
        ({
          copy() {
            return this;
          },
          addMessage() {},
          toJSON() {
            return { items: [] };
          },
        }) as any,
      onEndOfTurn: vi.fn(async () => true),
    };

    const now = Date.now();
    const vadEvents: VADEvent[] = [
      {
        type: VADEventType.START_OF_SPEECH,
        samplesIndex: 0,
        timestamp: now,
        speechDuration: 100,
        silenceDuration: 0,
        frames: [],
        probability: 0,
        inferenceDuration: 0,
        speaking: true,
        rawAccumulatedSilence: 0,
        rawAccumulatedSpeech: 0,
      },
      {
        type: VADEventType.END_OF_SPEECH,
        samplesIndex: 0,
        timestamp: now + 200,
        speechDuration: 100,
        silenceDuration: 100,
        frames: [],
        probability: 0,
        inferenceDuration: 0,
        speaking: false,
        rawAccumulatedSilence: 0,
        rawAccumulatedSpeech: 0,
      },
    ];

    const sttEvents: SpeechEvent[] = [
      {
        type: SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            language: 'en',
            text: 'test',
            startTime: 0,
            endTime: 0,
            confidence: 0.8,
          },
        ],
      },
    ];

    const sttNode = async () =>
      new ReadableStream<SpeechEvent>({
        start(controller) {
          for (const ev of sttEvents) controller.enqueue(ev);
          controller.close();
        },
      });

    const ar = new AudioRecognition({
      recognitionHooks: hooks as any,
      stt: sttNode as any,
      vad: new FakeVAD(vadEvents) as any,
      turnDetector: alwaysTrueTurnDetector,
      turnDetectionMode: 'vad',
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
      sttModel: 'stt-model',
      sttProvider: 'stt-provider',
      getLinkedParticipant: () => ({ sid: 'p2', identity: 'alice', kind: ParticipantKind.AGENT }),
    });

    await ar.start();
    await new Promise((r) => setTimeout(r, 20));
    await ar.close();

    const spans = exporter.getFinishedSpans();
    const userTurn = spanByName(spans, 'user_turn');
    const eou = spanByName(spans, 'eou_detection');
    expect(userTurn).toBeTruthy();
    expect(eou).toBeTruthy();
    expect(eou.parentSpanId).toBe(userTurn.spanContext().spanId);

    expect(hooks.onStartOfSpeech).toHaveBeenCalled();
    expect(hooks.onEndOfSpeech).toHaveBeenCalled();
  });
});
