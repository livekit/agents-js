// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * FSM tests for `AudioTurnDetectorStream`.
 *
 * Covers the warmup → activate → deactivate / flush lifecycle and the
 * regression cases:
 *
 * - `deactivate()` from a pre-active state (the historical
 *   `setActive(false)` during WARMING_UP) must stop the inference cleanly
 *   so a late prediction for the cancelled request isn't replayed on the
 *   next activate.
 * - `predictEndOfTurn` timeout must leave the FSM consistent so the next
 *   `warmup()` can proceed.
 *
 * Port of Python `tests/test_turn_detection_fsm.py`.
 */
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import {
  type AudioTurnDetectionTransport,
  AudioTurnDetector,
  AudioTurnDetectorStream,
  type FlushSentinel,
  Status,
  type TurnDetectionEvent,
  type TurnDetectorOptions,
} from './audio_turn_detector.js';

class FakeTransport implements AudioTurnDetectionTransport {
  events: Array<[string, string]> = [];
  private _stream: AudioTurnDetectorStream | undefined;

  bind(stream: AudioTurnDetectorStream): void {
    this._stream = stream;
  }
  async run(): Promise<void> {
    if (this._stream === undefined) {
      throw new Error('stream not bound');
    }
    await this._stream._drainAudioChannel();
  }
  transportReady(): boolean {
    return true;
  }
  startInference(requestId: string): void {
    this.events.push(['start_inference', requestId]);
  }
  stopInference(reason?: string): void {
    this.events.push(['stop_inference', reason ?? '']);
  }
  async pushFrame(_frame: AudioFrame): Promise<void> {
    // no-op
  }
  async flush(_sentinel: FlushSentinel): Promise<void> {
    // no-op
  }
  detach(): void {
    // no-op
  }
}

class FakeDetector extends AudioTurnDetector {
  get model(): string {
    return 'eot-fake';
  }
  stream(): AudioTurnDetectorStream {
    throw new Error('unused in FSM tests');
  }
}

class FakeBackend extends AudioTurnDetectorStream {
  emitted: number[] = [];
  fakeTransport: FakeTransport;

  constructor(opts: TurnDetectorOptions) {
    const transport = new FakeTransport();
    super({ detector: new FakeDetector(opts), opts, transport });
    this.fakeTransport = transport;
  }

  get events(): Array<[string, string]> {
    return this.fakeTransport.events;
  }

  protected _emitEvent(event: TurnDetectionEvent): void {
    this.emitted.push(event.endOfTurnProbability);
    super._emitEvent(event);
  }

  simulatePrediction(requestId: string, probability: number): void {
    this._handlePrediction(requestId, probability);
  }

  // Exposed for assertions.
  get status(): Status {
    return this._status;
  }
  get preemptivePrediction(): TurnDetectionEvent | undefined {
    return this._preemptivePrediction;
  }
  get preemptiveRequestFut() {
    return this._preemptiveRequestFut;
  }
}

function makeOpts(): TurnDetectorOptions {
  return { sampleRate: 16000, thresholds: {} };
}

function makeStream(): FakeBackend {
  return new FakeBackend(makeOpts());
}

const countStartInference = (events: Array<[string, string]>) =>
  events.filter((e) => e[0] === 'start_inference').length;

describe('AudioTurnDetectionFSM', () => {
  it('warmup starts inference', async () => {
    const s = makeStream();
    try {
      const fut = s.warmup();
      expect(s.status).toBe(Status.IDLE);
      expect(s.isInferenceRunning).toBe(true);
      expect(s.preemptiveRequestId).toBeDefined();
      expect(fut.done).toBe(false);
      expect(s.events).toEqual([['start_inference', s.preemptiveRequestId!]]);
    } finally {
      await s.aclose();
    }
  });

  it('warmup is idempotent', async () => {
    const s = makeStream();
    try {
      s.warmup();
      const firstId = s.preemptiveRequestId;
      s.warmup();
      expect(s.preemptiveRequestId).toBe(firstId);
      expect(countStartInference(s.events)).toBe(1);
    } finally {
      await s.aclose();
    }
  });

  it('activate from warmed up', async () => {
    const s = makeStream();
    try {
      s.warmup();
      s.activate('vad eos');
      expect(s.status).toBe(Status.ACTIVE);
      expect(s.isInferenceRunning).toBe(true);
    } finally {
      await s.aclose();
    }
  });

  it('activate without warmup auto-warms-up', async () => {
    const s = makeStream();
    try {
      s.activate('manual');
      expect(s.status).toBe(Status.ACTIVE);
      expect(countStartInference(s.events)).toBe(1);
    } finally {
      await s.aclose();
    }
  });

  it('deactivate during preemptive phase stops inference', async () => {
    const s = makeStream();
    try {
      s.warmup();
      s.deactivate('vad sos');
      expect(s.status).toBe(Status.IDLE);
      expect(s.preemptiveRequestId).toBeUndefined();
      expect(s.isInferenceRunning).toBe(false);
      expect(s.events).toContainEqual(['stop_inference', 'vad sos']);
    } finally {
      await s.aclose();
    }
  });

  it('late prediction after deactivate not replayed', async () => {
    const s = makeStream();
    try {
      s.warmup();
      const cancelledId = s.preemptiveRequestId!;
      s.deactivate('vad sos');

      s.simulatePrediction(cancelledId, 0.9);
      expect(s.preemptivePrediction).toBeUndefined();

      s.warmup();
      s.activate('vad eos');
      expect(s.emitted).toEqual([]);
    } finally {
      await s.aclose();
    }
  });

  it('deactivate when idle is a no-op', async () => {
    const s = makeStream();
    try {
      s.deactivate('vad sos');
      expect(s.events).toEqual([]);
      expect(s.status).toBe(Status.IDLE);
    } finally {
      await s.aclose();
    }
  });

  it('deactivate during warmup resolves future with zero', async () => {
    const s = makeStream();
    try {
      const fut = s.warmup();
      s.deactivate();
      expect(fut.done).toBe(true);
      expect(await fut.await).toBe(0.0);
      expect(s.status).toBe(Status.IDLE);
      expect(s.preemptiveRequestId).toBeUndefined();
    } finally {
      await s.aclose();
    }
  });

  it('predictEndOfTurn timeout leaves fsm consistent', async () => {
    const s = makeStream();
    try {
      const prob = await s.predictEndOfTurn(undefined, { timeoutMs: 10 });
      expect(prob).toBe(1.0);
      expect(s.status).toBe(Status.IDLE);
      expect(s.preemptiveRequestId).toBeUndefined();
      expect(s.preemptiveRequestFut).toBeUndefined();
      expect(s.events).toContainEqual(['stop_inference', 'predict_end_of_turn timeout']);
    } finally {
      await s.aclose();
    }
  });

  it('predictEndOfTurn timeout allows next warmup', async () => {
    const s = makeStream();
    try {
      await s.predictEndOfTurn(undefined, { timeoutMs: 10 });
      const fut = s.warmup();
      expect(s.preemptiveRequestId).toBeDefined();
      expect(fut.done).toBe(false);
    } finally {
      await s.aclose();
    }
  });

  it('flush deactivates and emits stop_inference', async () => {
    const s = makeStream();
    try {
      s.warmup();
      s.activate();
      s.flush('turn committed');
      expect(s.status).toBe(Status.IDLE);
      expect(s.isInferenceRunning).toBe(false);
      expect(s.events).toContainEqual(['stop_inference', 'turn committed']);
    } finally {
      await s.aclose();
    }
  });

  it('activate releases preemptive prediction', async () => {
    const s = makeStream();
    try {
      s.warmup();
      const requestId = s.preemptiveRequestId!;
      s.simulatePrediction(requestId, 0.7);
      // Held — not emitted yet.
      expect(s.emitted).toEqual([]);
      expect(s.preemptivePrediction).toBeDefined();
      expect(s.preemptivePrediction?.endOfTurnProbability).toBe(0.7);

      s.activate();
      expect(s.emitted).toEqual([0.7]);
      expect(s.preemptivePrediction).toBeUndefined();
    } finally {
      await s.aclose();
    }
  });
});

describe('PredictOnSilenceGuard', () => {
  it('predict short-circuits after flush', async () => {
    const s = makeStream();
    try {
      s.flush('turn committed');
      const prob = await s.predictEndOfTurn(undefined, { timeoutMs: 1000 });
      expect(prob).toBe(1.0);
      expect(countStartInference(s.events)).toBe(0);
      expect(s.preemptiveRequestId).toBeUndefined();
    } finally {
      await s.aclose();
    }
  });

  it('predict runs after onSpeechStarted', async () => {
    const s = makeStream();
    try {
      s.flush('turn committed');
      s.onSpeechStarted();
      const prob = await s.predictEndOfTurn(undefined, { timeoutMs: 10 });
      expect(prob).toBe(1.0); // timed out
      expect(countStartInference(s.events)).toBe(1);
    } finally {
      await s.aclose();
    }
  });

  it('predict returns cached prediction before short-circuit', async () => {
    const s = makeStream();
    try {
      s.warmup();
      const requestId = s.preemptiveRequestId!;
      s.simulatePrediction(requestId, 0.4);
      const prob = await s.predictEndOfTurn(undefined, { timeoutMs: 1000 });
      expect(prob).toBe(0.4);
    } finally {
      await s.aclose();
    }
  });

  it('onSpeechStarted deactivates in-flight inference', async () => {
    const s = makeStream();
    try {
      s.warmup();
      s.activate();
      expect(s.isInferenceRunning).toBe(true);

      s.onSpeechStarted();

      expect(s.isInferenceRunning).toBe(false);
      expect(s.status).toBe(Status.IDLE);
      expect(s.events).toContainEqual(['stop_inference', 'vad sos']);
    } finally {
      await s.aclose();
    }
  });

  it('initial state does not short-circuit', async () => {
    const s = makeStream();
    try {
      const prob = await s.predictEndOfTurn(undefined, { timeoutMs: 10 });
      expect(prob).toBe(1.0); // timeout default
      expect(countStartInference(s.events)).toBe(1);
    } finally {
      await s.aclose();
    }
  });
});
