// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { DynamicEndpointing, createEndpointing } from './turn_config/endpointing.js';

function createHooks() {
  const hooks: RecognitionHooks = {
    onInterruption: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onEndOfTurn: vi.fn(async () => true),
    onPreemptiveGeneration: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
  };

  return hooks;
}

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeVADStream extends (Object as unknown as { new (): VADStream }) {
  private events: VADEvent[];
  private index = 0;

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
    if (this.index >= this.events.length) {
      return { done: true, value: undefined };
    }

    const value = this.events[this.index++]!;
    return { done: false, value };
  }
}

class FakeVAD extends VAD {
  label = 'fake-vad';

  constructor(private events: VADEvent[]) {
    super({ updateInterval: 1 });
  }

  stream(): VADStream {
    return new FakeVADStream(this.events);
  }
}

describe('AudioRecognition dynamic endpointing integration', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('uses learned dynamic delay for STT-driven end-of-turn scheduling', async () => {
    vi.useFakeTimers();

    const hooks = createHooks();
    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
      endpointing: new DynamicEndpointing(300, 1000, 0.5),
      turnDetectionMode: 'stt',
    });
    const onSTTEvent = (recognition as any).onSTTEvent.bind(recognition) as (
      ev: SpeechEvent,
    ) => Promise<void>;

    try {
      vi.setSystemTime(100000);
      await onSTTEvent({ type: SpeechEventType.START_OF_SPEECH });

      vi.setSystemTime(100500);
      await onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });

      vi.setSystemTime(100900);
      await onSTTEvent({ type: SpeechEventType.START_OF_SPEECH });

      vi.setSystemTime(101200);
      await onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });

      expect((recognition as any).endpointing.minDelay).toBeCloseTo(350, 5);

      await vi.advanceTimersByTimeAsync(349);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
    } finally {
      await recognition.close();
      vi.useRealTimers();
    }
  });

  it('updates dynamic endpointing from the VAD runtime path', async () => {
    vi.useFakeTimers();

    const hooks = createHooks();
    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      vad: new FakeVAD([
        {
          type: VADEventType.START_OF_SPEECH,
          samplesIndex: 0,
          timestamp: 0,
          speechDuration: 2000,
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
          timestamp: 0,
          speechDuration: 0,
          silenceDuration: 1500,
          frames: [],
          probability: 0,
          inferenceDuration: 0,
          speaking: false,
          rawAccumulatedSilence: 0,
          rawAccumulatedSpeech: 0,
        },
        {
          type: VADEventType.START_OF_SPEECH,
          samplesIndex: 0,
          timestamp: 0,
          speechDuration: 1100,
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
          timestamp: 0,
          speechDuration: 0,
          silenceDuration: 800,
          frames: [],
          probability: 0,
          inferenceDuration: 0,
          speaking: false,
          rawAccumulatedSilence: 0,
          rawAccumulatedSpeech: 0,
        },
      ]),
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
      endpointing: new DynamicEndpointing(300, 1000, 0.5),
      turnDetectionMode: 'vad',
    });

    try {
      vi.setSystemTime(102000);
      await recognition.start();
      await flushTasks();

      expect((recognition as any).endpointing.minDelay).toBeCloseTo(350, 5);

      await vi.advanceTimersByTimeAsync(349);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
    } finally {
      await recognition.close();
      vi.useRealTimers();
    }
  });

  it('passes false interruption results through to endpointing ignore logic', async () => {
    vi.useFakeTimers();

    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
      endpointing: new DynamicEndpointing(300, 1000, 0.5),
      turnDetectionMode: 'stt',
    });
    const endpointing = (recognition as any).endpointing as DynamicEndpointing;
    const onSTTEvent = (recognition as any).onSTTEvent.bind(recognition) as (
      ev: SpeechEvent,
    ) => Promise<void>;

    try {
      vi.setSystemTime(100500);
      await recognition.onStartOfAgentSpeech(100500);

      vi.setSystemTime(101500);
      await onSTTEvent({ type: SpeechEventType.START_OF_SPEECH });
      (recognition as any).onOverlapSpeechEvent({ isInterruption: false });

      const previousMin = endpointing.minDelay;
      const previousMax = endpointing.maxDelay;

      vi.setSystemTime(101800);
      await onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });

      expect(endpointing.minDelay).toBe(previousMin);
      expect(endpointing.maxDelay).toBe(previousMax);
      expect((endpointing as any).utteranceStartedAt).toBeUndefined();
      expect((endpointing as any).utteranceEndedAt).toBeUndefined();
    } finally {
      await recognition.close();
      vi.useRealTimers();
    }
  });

  it('replaces endpointing state on updateOptions', () => {
    const endpointing = new DynamicEndpointing(300, 1000, 0.5);
    endpointing.onEndOfSpeech(100000);
    endpointing.onStartOfSpeech(100400);
    endpointing.onEndOfSpeech(100600);
    expect(endpointing.minDelay).toBeCloseTo(350, 5);

    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
      endpointing,
      turnDetectionMode: 'stt',
    });

    recognition.updateOptions({
      endpointing: createEndpointing({ mode: 'dynamic', minDelay: 300, maxDelay: 1000 }),
      turnDetection: 'stt',
    });

    expect((recognition as any).endpointing.minDelay).toBe(300);
  });
});
