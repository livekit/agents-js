// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import type { Task } from '../utils.js';
import {
  AudioRecognition,
  type EndOfTurnInfo,
  type RecognitionHooks,
} from './audio_recognition.js';
import type { STTNode } from './io.js';

initializeLogger({ pretty: false, level: 'silent' });

const TRANSCRIPT = "what's the weather tomorrow";

interface RecognitionInternals {
  onSTTEvent(event: SpeechEvent): Promise<void>;
  commitUserTurnTask?: Task<void>;
  audioTranscript: string;
  audioInterimTranscript: string;
  lastFinalTranscriptTime: number;
  finalTranscriptConfidence: number[];
  sttRequestIds: string[];
  sttEvents: unknown[];
  userTurnSpan?: { isRecording(): boolean };
  runEOUDetection(chatCtx: ChatContext, trigger: 'vad' | 'stt' | 'manual'): void;
}

function finalTranscript(
  text: string,
  { confidence = 0.9, requestId }: { confidence?: number; requestId?: string } = {},
): SpeechEvent {
  return {
    type: SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [{ text, confidence }],
    requestId,
  };
}

function interimTranscript(text: string, requestId?: string): SpeechEvent {
  return {
    type: SpeechEventType.INTERIM_TRANSCRIPT,
    alternatives: [{ text }],
    requestId,
  };
}

function createRecognition(options: { stt?: STTNode; mode?: 'manual' | 'stt' } = {}) {
  const turns: EndOfTurnInfo[] = [];
  const hooks: RecognitionHooks = {
    interruptionByAudioActivityEnabled: false,
    onOverlapSpeech: vi.fn(),
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onEndOfTurn: vi.fn(async (info) => {
      turns.push({ ...info });
      return true;
    }),
    onPreemptiveGeneration: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    onUserTurnExceeded: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
  };
  const recognition = new AudioRecognition({
    recognitionHooks: hooks,
    stt: options.stt,
    turnDetectionMode: options.mode ?? 'manual',
    minEndpointingDelay: 500,
    maxEndpointingDelay: 500,
  });
  return {
    hooks,
    recognition,
    state: recognition as unknown as RecognitionInternals,
    turns,
  };
}

async function commit(
  recognition: AudioRecognition,
  state: RecognitionInternals,
): Promise<Task<void>> {
  recognition.commitUserTurn(false);
  await vi.advanceTimersByTimeAsync(0);
  await state.commitUserTurnTask?.result;
  const task = recognition.endOfTurnTask;
  if (!task) throw new Error('manual commit did not schedule end-of-turn delivery');
  return task;
}

describe.sequential('manual user turn snapshots', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;

  beforeEach(() => {
    vi.useFakeTimers();
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
    setTracerProvider(provider);
  });

  afterEach(async () => {
    vi.useRealTimers();
    setTracerProvider(originalProvider);
    await provider.shutdown();
    trace.disable();
    otelContext.disable();
  });

  it.each(['pending', 'delivered'] as const)(
    'clear preserves a %s committed snapshot and resets live input',
    async (phase) => {
      const { recognition, state, turns } = createRecognition();
      await state.onSTTEvent(finalTranscript(TRANSCRIPT));
      const task = await commit(recognition, state);
      if (phase === 'delivered') await vi.advanceTimersByTimeAsync(500);

      recognition.clearUserTurn();
      await state.onSTTEvent(interimTranscript('next turn'));
      await vi.advanceTimersByTimeAsync(500);

      expect(turns.map((turn) => turn.newTranscript)).toEqual([TRANSCRIPT]);
      expect(state.audioTranscript).toBe('');
      expect(state.audioInterimTranscript).toBe('next turn');
      await task.result;
      await recognition.close();
    },
  );

  it.each(['before_final', 'after_final', 'none'] as const)(
    'later finals remain live when clear order is %s',
    async (clearOrder) => {
      const { recognition, state, turns } = createRecognition();
      await state.onSTTEvent(finalTranscript(TRANSCRIPT));
      await commit(recognition, state);
      if (clearOrder === 'before_final') recognition.clearUserTurn();
      await state.onSTTEvent(finalTranscript('never mind', { confidence: 0.3 }));
      if (clearOrder === 'after_final') recognition.clearUserTurn();

      await vi.advanceTimersByTimeAsync(500);

      expect(turns[0]?.newTranscript).toBe(TRANSCRIPT);
      expect(state.audioTranscript).toBe(clearOrder === 'after_final' ? '' : 'never mind');
      expect(state.finalTranscriptConfidence).toEqual(clearOrder === 'after_final' ? [] : [0.3]);
      await recognition.close();
    },
  );

  it.each([false, true])('serializes overlapping commits (clear=%s)', async (clearBetween) => {
    const { recognition, state, turns } = createRecognition();
    await state.onSTTEvent(finalTranscript(TRANSCRIPT));
    const firstTask = await commit(recognition, state);
    if (clearBetween) recognition.clearUserTurn();
    await state.onSTTEvent(finalTranscript('next turn'));
    recognition.commitUserTurn(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await state.commitUserTurnTask?.result;
    await recognition.endOfTurnTask?.result;

    expect(firstTask.done).toBe(true);
    expect(turns.map((turn) => turn.newTranscript)).toEqual([TRANSCRIPT, 'next turn']);
    await recognition.close();
  });

  it('keeps interim input after the snapshot for the next commit', async () => {
    const { recognition, state, turns } = createRecognition();
    await state.onSTTEvent(finalTranscript(TRANSCRIPT));
    await commit(recognition, state);
    await state.onSTTEvent(interimTranscript('actually tomorrow'));
    await vi.advanceTimersByTimeAsync(500);

    expect(state.audioInterimTranscript).toBe('actually tomorrow');
    recognition.commitUserTurn(false);
    await vi.advanceTimersByTimeAsync(500);
    await state.commitUserTurnTask?.result;
    await vi.advanceTimersByTimeAsync(500);

    expect(turns.map((turn) => turn.newTranscript)).toEqual([TRANSCRIPT, 'actually tomorrow']);
    await recognition.close();
  });

  it('waits for a queued commit own final transcript', async () => {
    const { recognition, state, turns } = createRecognition();
    await state.onSTTEvent(finalTranscript(TRANSCRIPT));
    await commit(recognition, state);
    await state.onSTTEvent(interimTranscript('next interim'));
    recognition.commitUserTurn(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(turns.map((turn) => turn.newTranscript)).toEqual([TRANSCRIPT]);
    await state.onSTTEvent(finalTranscript('next final'));
    await vi.advanceTimersByTimeAsync(500);
    await state.commitUserTurnTask?.result;
    await vi.advanceTimersByTimeAsync(500);

    expect(turns.map((turn) => turn.newTranscript)).toEqual([TRANSCRIPT, 'next final']);
    await recognition.close();
  });

  it('an empty manual commit does not request a reply or block a later final', async () => {
    const stt: STTNode = async () => new ReadableStream<SpeechEvent | string>();
    const { recognition, state, turns } = createRecognition({ stt });
    recognition.commitUserTurn(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(turns).toEqual([]);

    await state.onSTTEvent(finalTranscript('next turn'));
    await commit(recognition, state);
    await vi.advanceTimersByTimeAsync(500);
    expect(turns.map((turn) => turn.newTranscript)).toEqual(['next turn']);
    await recognition.close();
  });

  it('an empty commit keeps STT turn detection ready for a late final', async () => {
    const stt: STTNode = async () => new ReadableStream<SpeechEvent | string>();
    const { recognition, state, turns } = createRecognition({ stt, mode: 'stt' });
    recognition.commitUserTurn(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(turns).toEqual([]);

    await state.onSTTEvent(finalTranscript(TRANSCRIPT));
    await vi.advanceTimersByTimeAsync(500);

    expect(turns.map((turn) => turn.newTranscript)).toEqual([TRANSCRIPT]);
    await recognition.close();
  });

  it('clear before snapshot discards the old transcript', async () => {
    const { recognition, state, turns } = createRecognition();
    await state.onSTTEvent(finalTranscript(TRANSCRIPT));
    state.lastFinalTranscriptTime = Date.now() - 1_000;
    recognition.commitUserTurn(false);
    recognition.clearUserTurn();
    await state.onSTTEvent(finalTranscript('replacement'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(turns.map((turn) => turn.newTranscript)).toEqual(['replacement']);
    await recognition.close();
  });

  it.each([false, true])(
    'snapshot tracing does not consume the next turn metadata (clear=%s)',
    async (clearBeforeFinal) => {
      const { recognition, state } = createRecognition();
      await state.onSTTEvent(interimTranscript("what's the weather", 'first'));
      await state.onSTTEvent(finalTranscript(TRANSCRIPT, { requestId: 'first' }));
      await commit(recognition, state);
      if (clearBeforeFinal) recognition.clearUserTurn();
      await state.onSTTEvent(finalTranscript('next turn', { confidence: 0.3, requestId: 'first' }));
      await vi.advanceTimersByTimeAsync(500);

      expect(state.sttRequestIds).toEqual(['first']);
      expect(state.sttEvents).toHaveLength(1);
      await commit(recognition, state);
      await vi.advanceTimersByTimeAsync(500);

      const turns = exporter.getFinishedSpans().filter((span) => span.name === 'user_turn');
      expect(turns).toHaveLength(2);
      expect(turns[0]?.attributes[traceTypes.ATTR_PROVIDER_REQUEST_IDS]).toEqual(['first']);
      expect(turns[0]?.attributes[traceTypes.ATTR_USER_TRANSCRIPT]).toBe(TRANSCRIPT);
      expect(turns[1]?.attributes[traceTypes.ATTR_PROVIDER_REQUEST_IDS]).toEqual(['first']);
      expect(turns[1]?.attributes[traceTypes.ATTR_TRANSCRIPT_CONFIDENCE]).toBeCloseTo(0.3);
      await recognition.close();
    },
  );

  it.each([false, true])(
    'mode changes preserve or close snapshot spans (clear=%s)',
    async (clear) => {
      const { recognition, state, turns } = createRecognition();
      await state.onSTTEvent(finalTranscript(TRANSCRIPT));
      const manualTask = await commit(recognition, state);
      const span = state.userTurnSpan;
      expect(span?.isRecording()).toBe(true);
      if (clear) recognition.clearUserTurn();

      recognition.updateOptions({ turnDetection: 'vad' });
      await vi.advanceTimersByTimeAsync(0);
      await expect(manualTask.result).rejects.toMatchObject({ name: 'AbortError' });
      if (!clear) {
        state.runEOUDetection(ChatContext.empty(), 'vad');
        await vi.advanceTimersByTimeAsync(500);
        expect(turns.map((turn) => turn.newTranscript)).toEqual([TRANSCRIPT]);
      } else {
        expect(turns).toEqual([]);
      }
      expect(span?.isRecording()).toBe(false);
      await recognition.close();
    },
  );
});
