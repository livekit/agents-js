// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind } from '@livekit/rtc-node';
import { ROOT_CONTEXT, context as otelContext, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { setTracerProvider, tracer } from '../telemetry/index.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import { AgentSession } from './agent_session.js';
import {
  AudioRecognition,
  type RecognitionHooks,
  type _TurnDetector,
} from './audio_recognition.js';
import type { STTNode } from './io.js';
import { BaseEndpointing } from './turn_config/dynamic_endpointing.js';

function setupInMemoryTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  setTracerProvider(provider);
  return { exporter };
}

function spanByName(spans: ReadableSpan[], name: string) {
  return spans.find((s) => s.name === name);
}

function createFakeSession(rootSpanContext = ROOT_CONTEXT): AgentSession {
  return {
    _agentState: 'listening',
    _roomIO: {
      linkedParticipant: { sid: 'p3', identity: 'charlie', kind: ParticipantKind.AGENT },
    },
    _setUserAwayTimer: vi.fn(),
    _cancelUserAwayTimer: vi.fn(),
    _userSpeakingSpan: undefined,
    _userState: 'listening',
    emit: vi.fn(),
    rootSpanContext,
  } as unknown as AgentSession;
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
  model: 'test-turn-detector',
  provider: 'test-provider',
  supportsLanguage: async () => true,
  unlikelyThreshold: async () => undefined,
  predictEndOfTurn: async () => 1.0,
};

describe('AudioRecognition user_turn span parity', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('creates user_turn and parents eou_detection under it (stt mode)', async () => {
    const { exporter } = setupInMemoryTracing();

    const hooks: RecognitionHooks = {
      onInterruption: vi.fn(),
      onStartOfSpeech: vi.fn(),
      onVADInferenceDone: vi.fn(),
      onEndOfSpeech: vi.fn(),
      onInterimTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onPreemptiveGeneration: vi.fn(),
      retrieveChatCtx: () => ChatContext.empty(),
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

    const sttNode: STTNode = async () =>
      new ReadableStream<SpeechEvent | string>({
        start(controller) {
          for (const ev of sttEvents) controller.enqueue(ev);
          controller.close();
        },
      });

    const ar = new AudioRecognition({
      recognitionHooks: hooks,
      stt: sttNode,
      vad: undefined,
      turnDetector: alwaysTrueTurnDetector,
      turnDetectionMode: 'stt',
      endpointing: new BaseEndpointing({ minDelay: 0, maxDelay: 0 }),
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
    if (!userTurn || !eou) {
      throw new Error('expected user_turn and eou_detection spans');
    }

    expect(eou.parentSpanId).toBe(userTurn.spanContext().spanId);

    // creation-time attributes
    expect(userTurn.attributes['lk.participant_id']).toBe('p1');
    expect(userTurn.attributes['lk.participant_identity']).toBe('bob');
    expect(userTurn.attributes['lk.participant_kind']).toBe('AGENT');
    expect(userTurn.attributes['gen_ai.request.model']).toBe('deepgram-nova2');
    expect(userTurn.attributes['gen_ai.provider.name']).toBe('deepgram');

    // end-of-turn attributes
    expect(userTurn.attributes['lk.user_transcript']).toContain('hello');
    expect(userTurn.attributes['lk.transcript_confidence']).toBeGreaterThan(0);
  });

  it('creates user_turn from VAD startTime (vad mode) and keeps same parenting', async () => {
    const { exporter } = setupInMemoryTracing();

    const hooks: RecognitionHooks = {
      onInterruption: vi.fn(),
      onStartOfSpeech: vi.fn(),
      onVADInferenceDone: vi.fn(),
      onEndOfSpeech: vi.fn(),
      onInterimTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onPreemptiveGeneration: vi.fn(),
      retrieveChatCtx: () => ChatContext.empty(),
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

    const sttNode: STTNode = async () =>
      new ReadableStream<SpeechEvent | string>({
        start(controller) {
          for (const ev of sttEvents) controller.enqueue(ev);
          controller.close();
        },
      });

    const ar = new AudioRecognition({
      recognitionHooks: hooks,
      stt: sttNode,
      vad: new FakeVAD(vadEvents),
      turnDetector: alwaysTrueTurnDetector,
      turnDetectionMode: 'vad',
      endpointing: new BaseEndpointing({ minDelay: 0, maxDelay: 0 }),
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
    if (!userTurn || !eou) {
      throw new Error('expected user_turn and eou_detection spans');
    }
    expect(eou.parentSpanId).toBe(userTurn.spanContext().spanId);

    expect(hooks.onStartOfSpeech).toHaveBeenCalled();
    expect(hooks.onEndOfSpeech).toHaveBeenCalled();
  });

  it('parents user_speaking under user_turn when an explicit speech context is provided', () => {
    const { exporter } = setupInMemoryTracing();
    const sessionSpan = tracer.startSpan({ name: 'agent_session', context: ROOT_CONTEXT });
    const sessionContext = trace.setSpan(ROOT_CONTEXT, sessionSpan);
    const fakeSession = createFakeSession(sessionContext);
    const userTurn = tracer.startSpan({ name: 'user_turn', context: sessionContext });
    const userTurnContext = trace.setSpan(sessionContext, userTurn);
    const speakingStartedAt = Date.now() - 100;
    const speakingEndedAt = Date.now();

    otelContext.with(userTurnContext, () => {
      AgentSession.prototype._updateUserState.call(fakeSession, 'speaking', {
        lastSpeakingTime: speakingStartedAt,
        otelContext: otelContext.active(),
      });
      AgentSession.prototype._updateUserState.call(fakeSession, 'listening', {
        lastSpeakingTime: speakingEndedAt,
        otelContext: otelContext.active(),
      });
    });

    userTurn.end();
    sessionSpan.end();

    const spans = exporter.getFinishedSpans();
    const userSpeaking = spanByName(spans, 'user_speaking');
    const exportedUserTurn = spanByName(spans, 'user_turn');
    expect(userSpeaking).toBeTruthy();
    expect(exportedUserTurn).toBeTruthy();
    if (!userSpeaking || !exportedUserTurn) {
      throw new Error('expected user_speaking and user_turn spans');
    }
    expect(userSpeaking.parentSpanId).toBe(exportedUserTurn.spanContext().spanId);
    expect(userSpeaking.attributes['lk.participant_id']).toBe('p3');
  });

  it('keeps user_speaking attached to the session root without an explicit speech context', () => {
    const { exporter } = setupInMemoryTracing();
    const sessionSpan = tracer.startSpan({ name: 'agent_session', context: ROOT_CONTEXT });
    const sessionContext = trace.setSpan(ROOT_CONTEXT, sessionSpan);
    const fakeSession = createFakeSession(sessionContext);

    AgentSession.prototype._updateUserState.call(fakeSession, 'speaking', {
      lastSpeakingTime: Date.now() - 100,
    });
    AgentSession.prototype._updateUserState.call(fakeSession, 'listening', {
      lastSpeakingTime: Date.now(),
    });

    sessionSpan.end();

    const spans = exporter.getFinishedSpans();
    const userSpeaking = spanByName(spans, 'user_speaking');
    expect(userSpeaking).toBeTruthy();
    if (!userSpeaking) {
      throw new Error('expected user_speaking span');
    }
    expect(userSpeaking.parentSpanId).toBe(sessionSpan.spanContext().spanId);
  });
});
