// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `AudioRecognition` audio turn-detection wiring.
 *
 * Covers concerns the FSM-level tests (`inference/eot/base.test.ts`) can't reach:
 *
 * 1. The speaking-guard race in `runEOUDetection` / `bounceEOUTaskWithSpeakingGuard`:
 *    setting `userSpeakingEvent` mid-bounce must abort the commit so a
 *    late-arriving start-of-speech doesn't ship the prior turn.
 * 2. Sub-threshold speech spikes that set `userSpeakingEvent` on `INFERENCE_DONE`
 *    without ever reaching `START_OF_SPEECH` must be cleared once speech drops
 *    back to zero, or the speaking-guard aborts every subsequent commit forever.
 * 3. `onEotPrediction` dedup across the vad-EOS and stt-final triggers that share
 *    one cached prediction.
 * 4. The `minSilenceDuration` validation guarding an audio-EOT + VAD pairing.
 *
 * Port of Python `tests/test_audio_recognition_turn_detection.py`.
 */
import { ParticipantKind } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import {
  BaseStreamingTurnDetector,
  BaseStreamingTurnDetectorStream,
  MIN_SILENCE_DURATION_MS,
  type TurnDetectionEvent,
} from '../inference/eot/base.js';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type VAD, type VADEvent, VADEventType } from '../vad.js';
import {
  AudioRecognition,
  type AudioRecognitionOptions,
  type RecognitionHooks,
  type _TurnDetector,
} from './audio_recognition.js';

initializeLogger({ pretty: false, level: 'silent' });

/** White-box view of the `AudioRecognition` internals these tests drive. */
interface RecognitionInternals {
  speaking: boolean;
  vad?: VAD;
  turnDetector?: _TurnDetector | BaseStreamingTurnDetector;
  turnDetectorStream?: BaseStreamingTurnDetectorStream;
  lastEmittedEotPrediction?: TurnDetectionEvent;
  lastSpeakingTime?: number;
  audioTranscript: string;
  audioInterimTranscript: string;
  audioPreflightTranscript: string;
  sttRequestIds: string[];
  userSpeakingEvent: { isSet: boolean; set: () => void; clear: () => void };
  bounceEOUTask?: {
    result: Promise<void>;
    cancel: () => void;
    cancelAndWait: () => Promise<void>;
    done: boolean;
  };
  runEOUDetection: (chatCtx: ChatContext, trigger?: 'vad' | 'stt' | 'manual') => void;
  createVadTask: (vad: VAD | undefined, signal: AbortSignal) => Promise<void>;
  checkVadSilenceRequirement: (detector?: _TurnDetector | BaseStreamingTurnDetector) => void;
  updateTurnDetector: (detector: _TurnDetector | BaseStreamingTurnDetector | undefined) => void;
  clearUserTurn: () => void;
}

function makeHooks(): RecognitionHooks {
  return {
    onInterruption: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onEotPrediction: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onUserTurnExceeded: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async () => false), // don't commit by default
  };
}

function makeRecognition(opts: Partial<AudioRecognitionOptions> = {}): {
  recognition: AudioRecognition;
  internals: RecognitionInternals;
  hooks: RecognitionHooks;
} {
  const hooks = makeHooks();
  const full: AudioRecognitionOptions = {
    recognitionHooks: hooks,
    stt: undefined,
    vad: undefined,
    interruptionDetection: undefined,
    turnDetectionMode: 'vad',
    minEndpointingDelay: 10,
    maxEndpointingDelay: 500,
    getLinkedParticipant: () => ({ sid: 'p1', identity: 'bob', kind: ParticipantKind.AGENT }),
    ...opts,
  };
  const recognition = new AudioRecognition(full);
  return { recognition, internals: recognition as unknown as RecognitionInternals, hooks };
}

/**
 * A fake audio-EOT detector stream that passes `instanceof BaseStreamingTurnDetectorStream`
 * (so `runEOUDetection` selects the audio path) with stubbed inference.
 */
function makeAudioStream(
  opts: { lastPrediction?: TurnDetectionEvent; probability?: number } = {},
): BaseStreamingTurnDetectorStream {
  const stream = Object.create(BaseStreamingTurnDetectorStream.prototype);
  stream._lastPrediction = opts.lastPrediction;
  stream.supportsLanguage = vi.fn(async () => true);
  stream.unlikelyThreshold = vi.fn(async () => 0.5);
  stream.predictEndOfTurn = vi.fn(async () => opts.probability ?? 0.0);
  stream.flush = vi.fn();
  stream.deactivate = vi.fn();
  stream.activate = vi.fn();
  stream.warmup = vi.fn();
  return stream as BaseStreamingTurnDetectorStream;
}

function makeAudioDetector(stream: BaseStreamingTurnDetectorStream): BaseStreamingTurnDetector {
  const detector = Object.create(BaseStreamingTurnDetector.prototype);
  detector.stream = vi.fn(() => stream);
  return detector as BaseStreamingTurnDetector;
}

function inferenceDone(rawAccumulatedSpeech: number): VADEvent {
  return {
    type: VADEventType.INFERENCE_DONE,
    samplesIndex: 0,
    timestamp: 0,
    speechDuration: 0,
    silenceDuration: 0,
    frames: [],
    probability: 0,
    inferenceDuration: 0,
    speaking: false,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech,
  };
}

/** Let queued microtasks + the VAD loop body run to completion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drive `createVadTask` against a scripted VAD stream so `INFERENCE_DONE`
 * events flow through the real handler. `feed()` resolves once the event has
 * been processed and the loop has parked awaiting the next one.
 */
function runScriptedVad(internals: RecognitionInternals): {
  feed: (ev: VADEvent) => Promise<void>;
  stop: () => Promise<void>;
} {
  let resolveNext: ((r: IteratorResult<VADEvent>) => void) | null = null;
  const buffered: VADEvent[] = [];
  let closed = false;

  const stream = {
    updateInputStream(_s: unknown) {},
    detachInputStream() {},
    close() {
      closed = true;
      if (resolveNext) {
        resolveNext({ done: true, value: undefined as never });
        resolveNext = null;
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<VADEvent> {
      return {
        next(): Promise<IteratorResult<VADEvent>> {
          if (buffered.length > 0) {
            return Promise.resolve({ done: false, value: buffered.shift()! });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined as never });
          }
          return new Promise((res) => {
            resolveNext = res;
          });
        },
      };
    },
  };

  const vad = { stream: () => stream } as unknown as VAD;
  const controller = new AbortController();
  const task = internals.createVadTask(vad, controller.signal);

  return {
    async feed(ev: VADEvent) {
      if (resolveNext) {
        const res = resolveNext;
        resolveNext = null;
        res({ done: false, value: ev });
      } else {
        buffered.push(ev);
      }
      await flush();
      await flush();
    },
    async stop() {
      controller.abort();
      await task.catch(() => {});
    },
  };
}

describe('TestSpeakingGuardRace', () => {
  it('cancels the in-flight bounce when speaking starts during endpointing', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);

    internals.runEOUDetection(ChatContext.empty(), 'vad');

    // The bounce is parked in the ~500ms endpointing delay. Fire the speaking
    // event well inside that window: the guard's race resolves with the
    // speaking branch and the bounce is aborted before it can commit.
    await new Promise((r) => setTimeout(r, 50));
    internals.userSpeakingEvent.set();

    expect(internals.bounceEOUTask).toBeDefined();
    await internals.bounceEOUTask!.result.catch(() => {});

    expect(hooks.onEndOfTurn).not.toHaveBeenCalled();
  });

  it('short-circuits without spawning the bounce when already speaking', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    internals.speaking = true;

    internals.runEOUDetection(ChatContext.empty(), 'vad');

    expect(internals.bounceEOUTask).toBeDefined();
    await internals.bounceEOUTask!.result.catch(() => {});

    expect(hooks.onEndOfTurn).not.toHaveBeenCalled();
    // The guard bailed before the bounce started, so no inference ran.
    expect((stream.predictEndOfTurn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

describe('TestSubThresholdSpeakingSpike', () => {
  it('clears the event when a sub-threshold spike subsides', async () => {
    const { internals } = makeRecognition();
    const vad = runScriptedVad(internals);
    try {
      // Spike crosses the activation threshold: event set, no START_OF_SPEECH.
      await vad.feed(inferenceDone(0.1));
      expect(internals.userSpeakingEvent.isSet).toBe(true);

      // Spike subsides before min-speech: accumulation resets to 0 → cleared.
      await vad.feed(inferenceDone(0.0));
      expect(internals.userSpeakingEvent.isSet).toBe(false);
    } finally {
      await vad.stop();
    }
  });

  it('keeps the event during a confirmed turn even on a zero-speech window', async () => {
    const { internals } = makeRecognition();
    internals.speaking = true;
    internals.userSpeakingEvent.set();

    const vad = runScriptedVad(internals);
    try {
      // Inside a confirmed turn END_OF_SPEECH owns the clear, not INFERENCE_DONE.
      await vad.feed(inferenceDone(0.0));
      expect(internals.userSpeakingEvent.isSet).toBe(true);
    } finally {
      await vad.stop();
    }
  });

  it('lets the next commit run after a stale spike set-then-cleared', async () => {
    const { internals, hooks } = makeRecognition({
      minEndpointingDelay: 10,
      maxEndpointingDelay: 20,
    });
    (hooks.onEndOfTurn as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);

    const vad = runScriptedVad(internals);
    try {
      await vad.feed(inferenceDone(0.1));
      await vad.feed(inferenceDone(0.0));
      expect(internals.userSpeakingEvent.isSet).toBe(false);

      internals.runEOUDetection(ChatContext.empty(), 'vad');
      expect(internals.bounceEOUTask).toBeDefined();
      await internals.bounceEOUTask!.result.catch(() => {});

      // A stuck event would have aborted the bounce; it must commit instead.
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
    } finally {
      await vad.stop();
    }
  });
});

describe('TestEotPredictionDedup', () => {
  const cachedPrediction = (): TurnDetectionEvent => ({
    type: 'eot_prediction',
    endOfTurnProbability: 0.2,
    lastSpeakingTimeMs: 0,
    inferenceDuration: 50,
    detectionDelay: 100,
  });

  it('emits onEotPrediction once across vad then stt triggers', async () => {
    const { internals, hooks } = makeRecognition();
    // One cached prediction per inference window — both triggers read this by
    // reference via `turnDetectorStream.lastPrediction`.
    const cached = cachedPrediction();
    const stream = makeAudioStream({ lastPrediction: cached });
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);

    // vad trigger: bounce emits, then parks in the endpointing sleep.
    internals.runEOUDetection(ChatContext.empty(), 'vad');
    await flush();
    await flush();
    expect(hooks.onEotPrediction).toHaveBeenCalledTimes(1);

    // stt trigger: cancels the parked vad bounce and runs a fresh one that
    // reads the same cached prediction. Dedup must suppress a second emit.
    internals.runEOUDetection(ChatContext.empty(), 'stt');
    await flush();
    await flush();

    expect(hooks.onEotPrediction).toHaveBeenCalledTimes(1);
    expect(internals.lastEmittedEotPrediction).toBe(cached);

    await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
  });

  it('emits on every bounce when there is no cached prediction', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream({ lastPrediction: undefined });
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);

    internals.runEOUDetection(ChatContext.empty(), 'vad');
    await flush();
    await flush();
    expect(hooks.onEotPrediction).toHaveBeenCalledTimes(1);

    internals.runEOUDetection(ChatContext.empty(), 'stt');
    await flush();
    await flush();
    expect(hooks.onEotPrediction).toHaveBeenCalledTimes(2);

    await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
  });

  it('emits on every bounce for a text-based detector', async () => {
    const { internals, hooks } = makeRecognition();
    // A text detector is not an BaseStreamingTurnDetector → no streaming window, so
    // `lastPrediction` is always undefined and dedup never applies.
    const textDetector: _TurnDetector = {
      model: 'fake',
      provider: 'fake',
      supportsLanguage: vi.fn(async () => true),
      unlikelyThreshold: vi.fn(async () => 0.5),
      predictEndOfTurn: vi.fn(async () => 0.2),
    };
    internals.turnDetector = textDetector;
    internals.turnDetectorStream = undefined;
    internals.audioTranscript = 'hello there';

    internals.runEOUDetection(ChatContext.empty(), 'vad');
    await flush();
    await flush();
    expect(hooks.onEotPrediction).toHaveBeenCalledTimes(1);

    internals.runEOUDetection(ChatContext.empty(), 'stt');
    await flush();
    await flush();
    expect(hooks.onEotPrediction).toHaveBeenCalledTimes(2);

    await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
  });

  it('clearUserTurn resets the dedup guard so the next turn emits again', () => {
    const { internals } = makeRecognition();
    internals.lastEmittedEotPrediction = cachedPrediction();
    internals.audioInterimTranscript = '';
    internals.audioPreflightTranscript = '';
    internals.sttRequestIds = [];

    internals.clearUserTurn();

    expect(internals.lastEmittedEotPrediction).toBeUndefined();
  });
});

describe('TestVadMinSilenceRequirement', () => {
  // The audio EOT detector needs ~200ms of trailing silence, so the VAD must
  // report END_OF_SPEECH no earlier than that floor + a 50ms margin.
  const requiredMs = MIN_SILENCE_DURATION_MS + 50;
  const fakeVad = (minSilenceDuration: number | null): VAD =>
    ({ minSilenceDuration }) as unknown as VAD;

  it('raises when min silence is too low for an audio detector', () => {
    const { internals } = makeRecognition();
    internals.vad = fakeVad(requiredMs - 1);
    internals.turnDetector = makeAudioDetector(makeAudioStream());

    expect(() => internals.checkVadSilenceRequirement()).toThrow(/minSilenceDuration/);
  });

  it('passes when min silence is adequate', () => {
    const { internals } = makeRecognition();
    internals.vad = fakeVad(requiredMs + 250);
    internals.turnDetector = makeAudioDetector(makeAudioStream());

    expect(() => internals.checkVadSilenceRequirement()).not.toThrow();
  });

  it('skips validation for a non-audio detector', () => {
    const { internals } = makeRecognition();
    internals.vad = fakeVad(requiredMs - 1);
    internals.turnDetector = { model: 'x', provider: 'x' } as unknown as _TurnDetector;

    expect(() => internals.checkVadSilenceRequirement()).not.toThrow();
  });

  it('skips validation when there is no VAD', () => {
    const { internals } = makeRecognition();
    internals.vad = undefined;
    internals.turnDetector = makeAudioDetector(makeAudioStream());

    expect(() => internals.checkVadSilenceRequirement()).not.toThrow();
  });

  it('skips validation when the VAD exposes no min-silence knob', () => {
    const { internals } = makeRecognition();
    // A VAD whose minSilenceDuration is null can't be validated → allowed.
    internals.vad = fakeVad(null);
    internals.turnDetector = makeAudioDetector(makeAudioStream());

    expect(() => internals.checkVadSilenceRequirement()).not.toThrow();
  });

  it('updateTurnDetector validates the pairing before building a stream', () => {
    const { internals } = makeRecognition();
    internals.vad = fakeVad(requiredMs - 1);
    const stream = makeAudioStream();
    const detector = makeAudioDetector(stream);

    expect(() => internals.updateTurnDetector(detector)).toThrow(/minSilenceDuration/);

    // Aborted before adopting the detector or opening a stream.
    expect(internals.turnDetectorStream).toBeUndefined();
    expect((detector.stream as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
