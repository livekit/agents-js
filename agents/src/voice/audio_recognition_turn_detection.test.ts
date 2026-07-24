// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `AudioRecognition` audio turn-detection wiring.
 *
 * Recognition owns all streaming turn-detection policy: it holds the in-flight
 * inference request's future (`turnDetectorPredictionFut`), starts requests on
 * VAD events only, awaits the future with the model `predictionTimeout` in the
 * eou bounce, and flushes the stream on turn commits. Covered here:
 *
 * 1. Resumed speech during the endpointing window: a `START_OF_SPEECH`
 *    mid-bounce cancels the in-flight eou task so the prior turn doesn't ship.
 * 2. `onEotPrediction` dedup across the vad-EOS and stt-final triggers that
 *    share one resolved prediction future.
 * 3. The prediction-future lifecycle against VAD events: requests start
 *    exclusively on the silence tick, resumed speech rearms the next pause, SOS
 *    teardown, the flushed-turn short-circuit for late stt finals, and the
 *    predict-timeout fallback signal.
 * 4. The `minSilenceDuration` validation guarding an audio-EOT + VAD pairing.
 *
 * The stream-side request lifecycle lives in `inference/eot/base.test.ts`.
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
import { Future } from '../utils.js';
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
  isAgentSpeaking: boolean;
  vad?: VAD;
  turnDetector?: _TurnDetector | BaseStreamingTurnDetector;
  turnDetectorStream?: BaseStreamingTurnDetectorStream;
  turnDetectorPredictionFut?: Future<TurnDetectionEvent>;
  turnDetectorFlushed: boolean;
  turnDetectorLatePredictionWarned: boolean;
  lastEmittedEotPrediction?: TurnDetectionEvent;
  lastSpeakingTime?: number;
  audioTranscript: string;
  audioInterimTranscript: string;
  audioPreflightTranscript: string;
  sttRequestIds: string[];
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
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onEotPrediction: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
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
 * (so `runEOUDetection` selects the audio path). `predict` hands out a fresh
 * pending future each call, mirroring the real stream; tests install
 * resolved/pending futures directly on `internals.turnDetectorPredictionFut` to
 * model cached/awaiting predictions.
 */
function makeAudioStream(): BaseStreamingTurnDetectorStream {
  const stream = Object.create(BaseStreamingTurnDetectorStream.prototype);
  stream.supportsLanguage = vi.fn(async () => true);
  stream.unlikelyThreshold = vi.fn(async () => 0.5);
  // backchannel disabled by default (server sent no thresholds); the
  // backchannel-emit tests override this with a positive threshold.
  stream.backchannelThreshold = vi.fn(async () => undefined);
  Object.defineProperty(stream, 'predictionTimeout', { value: 10 });
  stream.predict = vi.fn(() => new Future<TurnDetectionEvent>());
  stream.cancelInference = vi.fn();
  stream.flush = vi.fn();
  return stream as BaseStreamingTurnDetectorStream;
}

function makeAudioDetector(stream: BaseStreamingTurnDetectorStream): BaseStreamingTurnDetector {
  const detector = Object.create(BaseStreamingTurnDetector.prototype);
  detector.stream = vi.fn(() => stream);
  return detector as BaseStreamingTurnDetector;
}

/** A resolved prediction future, as if the transport already answered. */
function resolvedPrediction(
  probability: number,
  opts: {
    inferenceDuration?: number;
    detectionDelay?: number;
    backchannelProbability?: number;
  } = {},
): { fut: Future<TurnDetectionEvent>; event: TurnDetectionEvent } {
  const event: TurnDetectionEvent = {
    type: 'eot_prediction',
    endOfTurnProbability: probability,
    lastSpeakingTimeMs: 0,
    inferenceDuration: opts.inferenceDuration,
    detectionDelay: opts.detectionDelay,
    backchannelProbability: opts.backchannelProbability,
  };
  const fut = new Future<TurnDetectionEvent>();
  fut.resolve(event);
  return { fut, event };
}

function predictMock(stream: BaseStreamingTurnDetectorStream): ReturnType<typeof vi.fn> {
  return stream.predict as unknown as ReturnType<typeof vi.fn>;
}

function cancelInferenceMock(stream: BaseStreamingTurnDetectorStream): ReturnType<typeof vi.fn> {
  return stream.cancelInference as unknown as ReturnType<typeof vi.fn>;
}

function inferenceDone(rawAccumulatedSpeech: number, rawAccumulatedSilence = 0): VADEvent {
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
    rawAccumulatedSilence,
    rawAccumulatedSpeech,
  };
}

function startOfSpeech(): VADEvent {
  return {
    type: VADEventType.START_OF_SPEECH,
    samplesIndex: 0,
    timestamp: 0,
    speechDuration: 500,
    silenceDuration: 0,
    frames: [],
    probability: 0,
    inferenceDuration: 0,
    speaking: true,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 500,
  };
}

function endOfSpeech(): VADEvent {
  return {
    type: VADEventType.END_OF_SPEECH,
    samplesIndex: 0,
    timestamp: 0,
    speechDuration: 0,
    silenceDuration: 300,
    frames: [],
    probability: 0,
    inferenceDuration: 0,
    speaking: false,
    rawAccumulatedSilence: 300,
    rawAccumulatedSpeech: 0,
  };
}

/** Let queued microtasks + the VAD loop body run to completion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drive `createVadTask` against a scripted VAD stream so VAD events flow
 * through the real handler. `feed()` resolves once the event has been processed
 * and the loop has parked awaiting the next one.
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

describe('TestResumedSpeechAbortsCommit', () => {
  it('cancels the in-flight bounce when VAD start-of-speech arrives during endpointing', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    // sub-threshold prediction (0.2 < 0.5) extends endpointing to maxDelay
    internals.turnDetectorPredictionFut = resolvedPrediction(0.2).fut;

    internals.runEOUDetection(ChatContext.empty(), 'vad');
    const task = internals.bounceEOUTask;
    expect(task).toBeDefined();

    // The bounce is parked in the ~500ms endpointing delay. Resumed speech
    // well inside that window tears the bounce down via the VAD SOS handler.
    await new Promise((r) => setTimeout(r, 50));
    const vad = runScriptedVad(internals);
    try {
      await vad.feed(startOfSpeech());
    } finally {
      await vad.stop();
    }

    await task!.result.catch(() => {});

    expect(hooks.onEndOfTurn).not.toHaveBeenCalled();
  });
});

describe('TestEotPredictionDedup', () => {
  it('emits onEotPrediction once across vad then stt triggers', async () => {
    const { internals, hooks } = makeRecognition();
    // One prediction per inference request — both triggers read this event by
    // reference from the held future.
    const { fut, event } = resolvedPrediction(0.2, { inferenceDuration: 50, detectionDelay: 100 });
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    internals.turnDetectorPredictionFut = fut;

    // vad trigger: bounce emits, then parks in the endpointing sleep.
    internals.runEOUDetection(ChatContext.empty(), 'vad');
    await flush();
    await flush();
    expect(hooks.onEotPrediction).toHaveBeenCalledTimes(1);

    // stt trigger: cancels the parked vad bounce and runs a fresh one that
    // reads the same resolved future. Dedup must suppress a second emit.
    internals.runEOUDetection(ChatContext.empty(), 'stt');
    await flush();
    await flush();

    expect(hooks.onEotPrediction).toHaveBeenCalledTimes(1);
    expect(internals.lastEmittedEotPrediction).toBe(event);

    await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
  });

  it('emits on every bounce for a text-based detector', async () => {
    const { internals, hooks } = makeRecognition();
    // A text detector is not a BaseStreamingTurnDetector → no streaming window,
    // so there's no shared prediction event and dedup never applies.
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
    internals.lastEmittedEotPrediction = resolvedPrediction(0.2).event;
    internals.audioInterimTranscript = '';
    internals.audioPreflightTranscript = '';
    internals.sttRequestIds = [];

    internals.clearUserTurn();

    expect(internals.lastEmittedEotPrediction).toBeUndefined();
  });
});

describe('TestBackchannelOpportunityEmit', () => {
  // `onAgentBackchannelOpportunity` fires whenever the backchannel probability
  // clears its threshold, regardless of end-of-turn; the event carries the
  // end-of-turn probability and threshold so AgentActivity can gauge how close
  // the pause is to a reply.
  async function drive(internals: RecognitionInternals): Promise<void> {
    internals.runEOUDetection(ChatContext.empty(), 'vad');
    await flush();
    await flush();
    await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
  }

  it('emits with eot context when the turn continues', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    stream.backchannelThreshold = vi.fn(async () => 0.5);
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    // eot 0.2 < unlikely 0.5 → turn continues; backchannel 0.8 >= 0.5 → emit
    internals.turnDetectorPredictionFut = resolvedPrediction(0.2, {
      backchannelProbability: 0.8,
    }).fut;

    await drive(internals);

    expect(hooks.onAgentBackchannelOpportunity).toHaveBeenCalledTimes(1);
    const ev = (hooks.onAgentBackchannelOpportunity as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(ev.probability).toBeCloseTo(0.8);
    expect(ev.threshold).toBeCloseTo(0.5);
    expect(ev.endOfTurnProbability).toBeCloseTo(0.2);
    expect(ev.endOfTurnThreshold).toBeCloseTo(0.5);
  });

  it('emits once across vad then stt triggers (shares the eot dedupe)', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    stream.backchannelThreshold = vi.fn(async () => 0.5);
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    // both triggers read the same cached prediction by reference
    internals.turnDetectorPredictionFut = resolvedPrediction(0.2, {
      backchannelProbability: 0.8,
    }).fut;

    internals.runEOUDetection(ChatContext.empty(), 'vad');
    await flush();
    await flush();
    expect(hooks.onAgentBackchannelOpportunity).toHaveBeenCalledTimes(1);

    // stt trigger runs a fresh bounce against the same resolved future; the
    // dedupe that suppresses the second eot emit must suppress this too.
    internals.runEOUDetection(ChatContext.empty(), 'stt');
    await flush();
    await flush();

    expect(hooks.onAgentBackchannelOpportunity).toHaveBeenCalledTimes(1);
    await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
  });

  it('emits with eot context when the turn ends', async () => {
    // The turn-continuing gate was dropped: a backchannel above threshold still
    // fires at end-of-turn, carrying the EOT context (probability past the
    // threshold) so AgentActivity can let it lead the reply.
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    stream.backchannelThreshold = vi.fn(async () => 0.5);
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    // eot 0.9 >= unlikely 0.5 → turn ends; backchannel 0.8 >= 0.5 → still emits
    internals.turnDetectorPredictionFut = resolvedPrediction(0.9, {
      backchannelProbability: 0.8,
    }).fut;

    await drive(internals);

    expect(hooks.onAgentBackchannelOpportunity).toHaveBeenCalledTimes(1);
    const ev = (hooks.onAgentBackchannelOpportunity as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(ev.endOfTurnProbability).toBeCloseTo(0.9);
    expect(ev.endOfTurnThreshold).toBeCloseTo(0.5);
  });

  it('does not emit below threshold', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    stream.backchannelThreshold = vi.fn(async () => 0.7);
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    // backchannel 0.4 < 0.7 → no emit (turn continues at eot 0.2)
    internals.turnDetectorPredictionFut = resolvedPrediction(0.2, {
      backchannelProbability: 0.4,
    }).fut;

    await drive(internals);

    expect(hooks.onAgentBackchannelOpportunity).not.toHaveBeenCalled();
  });

  it('does not emit when backchannel is disabled', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    // default fake threshold is undefined (server sent no backchannel defaults)
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    internals.turnDetectorPredictionFut = resolvedPrediction(0.2, {
      backchannelProbability: 0.9,
    }).fut;

    await drive(internals);

    expect(hooks.onAgentBackchannelOpportunity).not.toHaveBeenCalled();
  });

  it('does not emit for a text-based detector', async () => {
    // A text detector produces no streaming prediction event, so there is no
    // backchannel probability to act on.
    const { internals, hooks } = makeRecognition();
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

    await drive(internals);

    expect(hooks.onAgentBackchannelOpportunity).not.toHaveBeenCalled();
  });
});

describe('TestPredictionFutureLifecycle', () => {
  it('silence tick starts a request once', async () => {
    const { internals } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    internals.speaking = true;

    const vad = runScriptedVad(internals);
    try {
      await vad.feed(inferenceDone(0, 300));
      await vad.feed(inferenceDone(0, 400));

      expect(predictMock(stream).mock.calls.length).toBe(1);
      expect(internals.turnDetectorPredictionFut).toBeDefined();
    } finally {
      await vad.stop();
    }
  });

  it('resumed speech without SOS rearms the next pause', async () => {
    const { internals } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    internals.speaking = true;

    const vad = runScriptedVad(internals);
    try {
      await vad.feed(inferenceDone(0, 300));
      const firstFut = internals.turnDetectorPredictionFut;
      expect(firstFut).toBeDefined();
      firstFut!.resolve(resolvedPrediction(0.1).event);

      // Speech resumes inside the still-open VAD segment → drop the request.
      await vad.feed(inferenceDone(1, 0));
      expect(cancelInferenceMock(stream)).toHaveBeenCalledTimes(1);
      expect(cancelInferenceMock(stream)).toHaveBeenCalledWith();
      expect(internals.turnDetectorPredictionFut).toBeUndefined();

      // The next pause gets a fresh window.
      await vad.feed(inferenceDone(0, 300));
      expect(predictMock(stream).mock.calls.length).toBe(2);
      expect(internals.turnDetectorPredictionFut).toBeDefined();
      expect(internals.turnDetectorPredictionFut).not.toBe(firstFut);
    } finally {
      await vad.stop();
    }
  });

  it('silence tick starts a request even while the agent is speaking', async () => {
    // The agent-speaking gate was dropped: the silence tick warms a prediction
    // during the user's pause even while the agent is still speaking.
    const { internals } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    internals.speaking = true;
    internals.isAgentSpeaking = true;

    const vad = runScriptedVad(internals);
    try {
      await vad.feed(inferenceDone(0, 300));
      expect(predictMock(stream).mock.calls.length).toBe(1);
      expect(internals.turnDetectorPredictionFut).toBeDefined();
    } finally {
      await vad.stop();
    }
  });

  it('EOS consumes the silence-tick request without predicting', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    internals.speaking = true;
    const { fut } = resolvedPrediction(0.9);
    internals.turnDetectorPredictionFut = fut;

    const vad = runScriptedVad(internals);
    try {
      await vad.feed(endOfSpeech());
      expect(predictMock(stream).mock.calls.length).toBe(0);
      expect(internals.turnDetectorPredictionFut).toBe(fut);
      expect(internals.bounceEOUTask).toBeDefined();
      await internals.bounceEOUTask!.result.catch(() => {});
      expect(hooks.onEotPrediction).toHaveBeenCalledTimes(1);
    } finally {
      await vad.stop();
    }
  });

  it('SOS tears down the request and rearms', async () => {
    const { internals } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    internals.turnDetectorPredictionFut = new Future<TurnDetectionEvent>();
    internals.turnDetectorFlushed = true;

    const vad = runScriptedVad(internals);
    try {
      await vad.feed(startOfSpeech());
      expect(cancelInferenceMock(stream)).toHaveBeenCalledTimes(1);
      expect(cancelInferenceMock(stream)).toHaveBeenCalledWith();
      expect(internals.turnDetectorPredictionFut).toBeUndefined();
      expect(internals.turnDetectorFlushed).toBe(false);
    } finally {
      await vad.stop();
    }
  });

  it('EOS never starts a request', async () => {
    const { internals } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);

    const vad = runScriptedVad(internals);
    try {
      await vad.feed(endOfSpeech());
      expect(predictMock(stream).mock.calls.length).toBe(0);
      expect(internals.turnDetectorPredictionFut).toBeUndefined();

      const { fut } = resolvedPrediction(0.9);
      internals.turnDetectorPredictionFut = fut;
      await vad.feed(endOfSpeech());
      expect(predictMock(stream).mock.calls.length).toBe(0);
      expect(internals.turnDetectorPredictionFut).toBe(fut);
    } finally {
      await vad.stop();
    }
  });

  it('late stt final after flush short-circuits and warns once', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    internals.turnDetectorFlushed = true;

    for (let i = 0; i < 2; i++) {
      internals.runEOUDetection(ChatContext.empty(), 'stt');
      expect(internals.bounceEOUTask).toBeDefined();
      await internals.bounceEOUTask!.result.catch(() => {});
    }

    expect(predictMock(stream).mock.calls.length).toBe(0);
    expect(hooks.onEotPrediction).not.toHaveBeenCalled();
    // Warn-once: the flag flips on the first late prediction, debug after.
    expect(internals.turnDetectorLatePredictionWarned).toBe(true);
  });

  it('predict timeout signals fallback and drops the future', async () => {
    const { internals, hooks } = makeRecognition();
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    // A pending future that never resolves → times out at predictionTimeout.
    internals.turnDetectorPredictionFut = new Future<TurnDetectionEvent>();

    internals.runEOUDetection(ChatContext.empty(), 'vad');
    expect(internals.bounceEOUTask).toBeDefined();
    await internals.bounceEOUTask!.result.catch(() => {});

    expect(cancelInferenceMock(stream)).toHaveBeenCalledTimes(1);
    expect(cancelInferenceMock(stream)).toHaveBeenCalledWith({ timedOut: true });
    expect(internals.turnDetectorPredictionFut).toBeUndefined();
    expect(hooks.onEotPrediction).not.toHaveBeenCalled();
    expect(stream.unlikelyThreshold).not.toHaveBeenCalled();
    expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
  });

  it('commit flushes the stream and marks the turn flushed', async () => {
    const { internals, hooks } = makeRecognition();
    (hooks.onEndOfTurn as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const stream = makeAudioStream();
    internals.turnDetectorStream = stream;
    internals.turnDetector = makeAudioDetector(stream);
    // confident → no maxDelay extension
    internals.turnDetectorPredictionFut = resolvedPrediction(0.9).fut;

    internals.runEOUDetection(ChatContext.empty(), 'vad');
    expect(internals.bounceEOUTask).toBeDefined();
    await internals.bounceEOUTask!.result.catch(() => {});

    expect(stream.flush).toHaveBeenCalledWith('turn committed');
    expect(internals.turnDetectorPredictionFut).toBeUndefined();
    expect(internals.turnDetectorFlushed).toBe(true);
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
