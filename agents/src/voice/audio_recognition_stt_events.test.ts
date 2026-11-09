// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechData, type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { setTracerProvider, tracer } from '../telemetry/index.js';
import * as traceTypes from '../telemetry/trace_types.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { FakeLLM } from './testing/fake_llm.js';

interface RecognitionInternals {
  sttEvents: SttEventMetadata[];
  audioTranscript: string;
  transcriptGateActive: boolean;
  transcriptBuffer: SpeechEvent[];
  flushHeldTranscripts: () => void;
  onSTTEvent: (event: SpeechEvent) => Promise<void>;
  ensureUserTurnSpan: (startTime?: number) => unknown;
  runEOUDetection: (chatCtx: ChatContext, trigger: 'manual') => void;
}

interface SttEventMetadata {
  received_at: number;
  type: string;
  transcript_length: number;
}

function speechData(text: string): SpeechData {
  return { language: 'en', text, startTime: 0, endTime: 0, confidence: 1 };
}

function createRecognition(): AudioRecognition {
  const hooks: RecognitionHooks = {
    interruptionByAudioActivityEnabled: false,
    onOverlapSpeech: vi.fn(),
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onEotPrediction: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async () => true),
  };
  return new AudioRecognition({
    recognitionHooks: hooks,
    turnDetectionMode: 'manual',
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
  });
}

function turnEvents(exporter: InMemorySpanExporter): SttEventMetadata[][] {
  return exporter
    .getFinishedSpans()
    .filter((span: ReadableSpan) => span.name === 'user_turn')
    .map((span: ReadableSpan) => JSON.parse(String(span.attributes[traceTypes.ATTR_STT_EVENTS])));
}

describe.sequential('AudioRecognition STT event traces', () => {
  initializeLogger({ pretty: false, level: 'silent' });
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;

  beforeEach(() => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    setTracerProvider(provider);
  });

  afterEach(async () => {
    setTracerProvider(originalProvider);
    vi.restoreAllMocks();
    await provider.shutdown();
  });

  it('records transcript arrivals in order and resets them between turns', async () => {
    const recognition = createRecognition();
    const internals = recognition as unknown as RecognitionInternals;
    const origin = 1_000_000;
    const events = [
      [SpeechEventType.INTERIM_TRANSCRIPT, '你好🙂'],
      [SpeechEventType.PREFLIGHT_TRANSCRIPT, 'hello world'],
      [SpeechEventType.FINAL_TRANSCRIPT, 'hello world'],
      [SpeechEventType.FINAL_TRANSCRIPT, ''],
    ] as const;
    internals.transcriptGateActive = true;

    for (const [index, [type, text]] of events.entries()) {
      await internals.onSTTEvent({
        type,
        createdAt: origin + index * 100,
        alternatives: [speechData(text), speechData('unused alternative')],
      });
    }
    expect(internals.audioTranscript).toBe('');
    expect(internals.transcriptBuffer).toHaveLength(events.length);

    internals.ensureUserTurnSpan(origin - 100);
    internals.flushHeldTranscripts();
    internals.runEOUDetection(ChatContext.empty(), 'manual');
    await recognition.waitForEndOfTurnTask();

    expect(turnEvents(exporter)).toEqual([
      [
        { received_at: origin, type: 'interim_transcript', transcript_length: 3 },
        { received_at: origin + 100, type: 'preflight_transcript', transcript_length: 11 },
        { received_at: origin + 200, type: 'final_transcript', transcript_length: 11 },
        { received_at: origin + 300, type: 'final_transcript', transcript_length: 0 },
      ],
    ]);
    expect(internals.sttEvents).toEqual([]);

    await internals.onSTTEvent({
      type: SpeechEventType.FINAL_TRANSCRIPT,
      createdAt: origin + 400,
      alternatives: [speechData('next')],
    });
    internals.runEOUDetection(ChatContext.empty(), 'manual');
    await recognition.waitForEndOfTurnTask();
    expect(turnEvents(exporter).at(-1)).toEqual([
      { received_at: origin + 400, type: 'final_transcript', transcript_length: 4 },
    ]);
    await recognition.close();
  });

  it('commits a held transcript batch once with its original arrival metadata', async () => {
    const session = new AgentSession({
      vad: null,
      stt: new FakeSTT(),
      llm: new FakeLLM(),
      turnHandling: {
        turnDetection: 'vad',
        endpointing: { minDelay: 500, maxDelay: 500 },
      },
    });
    const agent = new Agent({ instructions: 'You are a helpful assistant.' });
    const origin = Date.now() - 10_000;
    await session.start({ agent });
    try {
      const recognition = (
        session as unknown as { activity: { audioRecognition: AudioRecognition } }
      ).activity.audioRecognition;
      const internals = recognition as unknown as RecognitionInternals;
      internals.transcriptGateActive = true;
      for (const [index, text] of ['one', 'second'].entries()) {
        await internals.onSTTEvent({
          type: SpeechEventType.FINAL_TRANSCRIPT,
          createdAt: origin + index * 100,
          speechEndTime: origin + index * 100,
          alternatives: [speechData(text)],
        });
      }
      expect(internals.transcriptBuffer).toHaveLength(2);
      await recognition.disableInterruptionDetection();
      await recognition.waitForEndOfTurnTask();
    } finally {
      await session.close();
    }

    expect(
      agent.chatCtx.items
        .filter((item) => item.type === 'message' && item.role === 'user')
        .map((item) => item.textContent),
    ).toEqual(['one second']);
    expect(turnEvents(exporter)).toEqual([
      [
        { received_at: origin, type: 'final_transcript', transcript_length: 3 },
        { received_at: origin + 100, type: 'final_transcript', transcript_length: 6 },
      ],
    ]);
  });

  it.each(['clear', 'close'] as const)(
    'keeps incomplete transcript metadata on %s',
    async (finish) => {
      const recognition = createRecognition();
      const internals = recognition as unknown as RecognitionInternals;
      internals.transcriptGateActive = true;
      vi.spyOn(Date, 'now').mockReturnValueOnce(1_000_000);
      await internals.onSTTEvent({
        type: SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives: [speechData('unfinished')],
      });

      if (finish === 'clear') recognition.clearUserTurn();
      else await recognition.close();

      expect(turnEvents(exporter)).toEqual([
        [{ received_at: 1_000_000, type: 'interim_transcript', transcript_length: 10 }],
      ]);
      expect(internals.sttEvents).toEqual([]);
    },
  );

  it('does not limit the transcript list to the span event count', async () => {
    const recognition = createRecognition();
    const internals = recognition as unknown as RecognitionInternals;
    internals.transcriptGateActive = true;
    for (let i = 0; i < 130; i++) {
      await internals.onSTTEvent({ type: SpeechEventType.INTERIM_TRANSCRIPT });
    }
    await recognition.close();

    const [events] = turnEvents(exporter);
    expect(events).toHaveLength(130);
    expect(events?.every((event) => event.transcript_length === 0)).toBe(true);
  });
});
