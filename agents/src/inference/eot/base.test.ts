// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Inference-request lifecycle tests for `BaseStreamingTurnDetectorStream`.
 *
 * The stream is a thin transport-facing surface: per-request state is one
 * `(requestId, requestFut)` pair. `predict` starts a request and returns its
 * future, superseding any previous request; the transport's single prediction
 * completes the request by resolving the future; `cancelInference`/`flush`
 * close a pending request, resolving its future with a default event so
 * waiters never hang. All policy (when to start a request, await timeout, turn
 * commits) lives in `AudioRecognition` and is covered by
 * `voice/audio_recognition_turn_detection.test.ts`.
 */
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import type { Future } from '../../utils.js';
import {
  BaseStreamingTurnDetector,
  type BaseStreamingTurnDetectorOptions,
  BaseStreamingTurnDetectorStream,
  type FlushSentinel,
  type StreamingTurnDetectionTransport,
  type TurnDetectionEvent,
} from './base.js';
import { ThresholdOptions, type TurnDetectorModel } from './languages.js';

class FakeTransport implements StreamingTurnDetectionTransport {
  events: Array<[string, string]> = [];
  private _stream: BaseStreamingTurnDetectorStream | undefined;

  attach(stream: BaseStreamingTurnDetectorStream): void {
    this._stream = stream;
  }
  async run(): Promise<void> {
    if (this._stream === undefined) {
      throw new Error('stream not bound');
    }
    await this._stream._drainAudioChannel();
  }
  runInference(requestId: string): void {
    this.events.push(['run_inference', requestId]);
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

class FakeDetector extends BaseStreamingTurnDetector {
  // Default to the local mini model so the timed-out-cancel test sees a
  // non-cloud model and skips the fallback.
  get model(): TurnDetectorModel {
    return 'turn-detector-v1-mini';
  }
  stream(): BaseStreamingTurnDetectorStream {
    throw new Error('unused in request-lifecycle tests');
  }
}

class FakeBackend extends BaseStreamingTurnDetectorStream {
  fakeTransport: FakeTransport;

  constructor(opts: BaseStreamingTurnDetectorOptions) {
    const transport = new FakeTransport();
    super({ detector: new FakeDetector(opts), opts, transport });
    this.fakeTransport = transport;
  }

  get events(): Array<[string, string]> {
    return this.fakeTransport.events;
  }

  /** Mirror what a transport would do: hand the prediction to the stream. */
  simulatePrediction(requestId: string, probability: number): void {
    this._resolvePrediction(requestId, probability);
  }

  // Exposed for assertions.
  get requestId(): string | undefined {
    return this._requestId;
  }
  get requestFut(): Future<TurnDetectionEvent> | undefined {
    return this._requestFut;
  }
}

function makeOpts(thresholds: Record<string, number> = {}): BaseStreamingTurnDetectorOptions {
  // Seed the resolved thresholds via a local-model dict override so `lookup`
  // returns them (unmapped languages fall back to the shipped local table).
  return {
    sampleRate: 16000,
    thresholds: new ThresholdOptions('turn-detector-v1-mini', thresholds),
  };
}

function makeStream(thresholds: Record<string, number> = {}): FakeBackend {
  return new FakeBackend(makeOpts(thresholds));
}

const countRunInference = (events: Array<[string, string]>) =>
  events.filter((e) => e[0] === 'run_inference').length;

describe('AudioTurnDetectionRequests', () => {
  it('predict starts inference', async () => {
    const s = makeStream();
    try {
      const fut = s.predict();
      expect(s.requestId).toBeDefined();
      expect(fut.done).toBe(false);
      expect(s.events).toEqual([['run_inference', s.requestId!]]);
    } finally {
      await s.aclose();
    }
  });

  it('predict supersedes previous request', async () => {
    const s = makeStream();
    try {
      const oldFut = s.predict();
      const oldId = s.requestId;
      const newFut = s.predict();

      expect(newFut).not.toBe(oldFut);
      expect(s.requestId).not.toBe(oldId);
      expect(oldFut.done).toBe(true);
      expect((await oldFut.await).endOfTurnProbability).toBe(0.0);
      expect(countRunInference(s.events)).toBe(2);
    } finally {
      await s.aclose();
    }
  });

  it('cancelInference closes the request', async () => {
    const s = makeStream();
    try {
      const fut = s.predict();
      s.cancelInference();

      expect(s.requestId).toBeUndefined();
      expect(fut.done).toBe(true);
      expect((await fut.await).endOfTurnProbability).toBe(0.0);
    } finally {
      await s.aclose();
    }
  });

  it('cancelInference when idle is a no-op', async () => {
    const s = makeStream();
    try {
      s.cancelInference();
      expect(s.events).toEqual([]);
    } finally {
      await s.aclose();
    }
  });

  it('late prediction after cancelInference is dropped', async () => {
    const s = makeStream();
    try {
      const fut = s.predict();
      const cancelledId = s.requestId!;
      expect(cancelledId).toBeDefined();

      s.cancelInference();
      s.simulatePrediction(cancelledId, 0.9);
      // cancelInference default (0.0), not the late 0.9.
      expect((await fut.await).endOfTurnProbability).toBe(0.0);

      const nextFut = s.predict();
      expect(nextFut).not.toBe(fut);
      expect(nextFut.done).toBe(false);
      expect(countRunInference(s.events)).toBe(2);
    } finally {
      await s.aclose();
    }
  });

  it('prediction completes the request', async () => {
    const s = makeStream();
    try {
      const fut = s.predict();
      const requestId = s.requestId!;
      expect(requestId).toBeDefined();

      s.simulatePrediction(requestId, 0.3);
      expect(fut.done).toBe(true);
      expect((await fut.await).endOfTurnProbability).toBe(0.3);
      expect(s.requestId).toBeUndefined();
    } finally {
      await s.aclose();
    }
  });

  it('flush closes the request', async () => {
    const s = makeStream();
    try {
      const fut = s.predict();
      s.flush('turn committed');
      expect(s.requestId).toBeUndefined();
      expect((await fut.await).endOfTurnProbability).toBe(0.0);
    } finally {
      await s.aclose();
    }
  });

  it('flush does not overwrite a resolved prediction', async () => {
    const s = makeStream();
    try {
      const fut = s.predict();
      const requestId = s.requestId!;
      expect(requestId).toBeDefined();
      s.simulatePrediction(requestId, 0.7);

      s.flush('turn committed');
      expect((await fut.await).endOfTurnProbability).toBe(0.7);
      expect(s.requestId).toBeUndefined();
    } finally {
      await s.aclose();
    }
  });

  it('predict after endInput returns a resolved default', async () => {
    const s = makeStream();
    try {
      s.endInput();
      // `endInput` closes the audio channel asynchronously; wait for it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const fut = s.predict();
      expect(fut.done).toBe(true);
      expect((await fut.await).endOfTurnProbability).toBe(1.0);
      expect(s.events.some((e) => e[0] === 'run_inference')).toBe(false);
    } finally {
      await s.aclose();
    }
  });

  it('aclose resolves a pending future', async () => {
    const s = makeStream();
    const fut = s.predict();
    await s.aclose();
    expect(fut.done).toBe(true);
    expect((await fut.await).endOfTurnProbability).toBe(0.0);
  });

  it('timed-out cancelInference does not fall back for the local model', async () => {
    // `timedOut: true` only promotes the cloud→local fallback for the cloud
    // model; the base stream (mini model) just closes the request — the cloud
    // case is covered in detector.test.ts.
    const s = makeStream();
    try {
      const fut = s.predict();
      s.cancelInference({ timedOut: true });
      expect((await fut.await).endOfTurnProbability).toBe(0.0);
      expect(s.model).toBe('turn-detector-v1-mini');
    } finally {
      await s.aclose();
    }
  });
});
