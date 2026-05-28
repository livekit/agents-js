// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the unified `AudioTurnDetector` (auto-select + fallback).
 *
 * Covers:
 *
 * - Auto-select via `LIVEKIT_REMOTE_EOT_URL` env var (with creds present,
 *   with creds missing → silent downgrade).
 * - Explicit-cloud missing creds throws.
 * - Cloud → local fallback triggers (transport raise, predict timeout).
 * - Fallback persistence across turns.
 * - Local-failure handling (default 1.0, retry on next turn).
 * - Per-session warning dedupe (one warning per failure mode).
 * - Threshold scaling: pass-through for cloud / explicit-local, multiplicative
 *   scaling only on actual fallback.
 *
 * Port of Python `tests/test_audio_turn_detector_fallback.py`.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError } from '../../_exceptions.js';
import type { InferenceExecutor } from '../../ipc/inference_executor.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import type { AudioTurnDetectorStream } from './base.js';
import {
  type AudioTurnDetectionTransport,
  type FlushSentinel,
  type TurnDetectorOptions,
} from './base.js';
import { AudioTurnDetector, AudioTurnDetectorStreamImpl } from './detector.js';
import { CLOUD_LANGUAGES, LOCAL_LANGUAGES, materializeThresholds } from './languages.js';
import { EOT_INFERENCE_METHOD } from './runner.js';
import { LocalTransport } from './transports.js';

async function waitFor(predicate: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
}

interface ScriptedTransportOptions {
  runBehavior?: 'idle' | 'raise' | 'return';
  runExc?: Error;
}

class ScriptedTransport implements AudioTurnDetectionTransport {
  runBehavior: 'idle' | 'raise' | 'return';
  runExc: Error | undefined;
  runCalls = 0;
  events: Array<[string, unknown]> = [];
  private _stream: AudioTurnDetectorStream | undefined;

  constructor(opts: ScriptedTransportOptions = {}) {
    this.runBehavior = opts.runBehavior ?? 'idle';
    this.runExc = opts.runExc;
  }

  attach(stream: AudioTurnDetectorStream): void {
    this._stream = stream;
  }
  async run(): Promise<void> {
    this.runCalls += 1;
    if (this.runBehavior === 'raise') {
      if (!this.runExc) throw new Error('runExc not set');
      throw this.runExc;
    }
    if (this.runBehavior === 'return') {
      return;
    }
    // idle — wait until cancelled (resolved by `detach()` via the
    // scripted transport's no-op; in our tests the parent stream
    // cancels via `aclose`).
    await new Promise(() => undefined);
  }
  startInference(requestId: string): void {
    this.events.push(['start_inference', requestId]);
  }
  async pushFrame(frame: AudioFrame): Promise<void> {
    this.events.push(['push_frame', frame]);
  }
  async flush(sentinel: FlushSentinel): Promise<void> {
    this.events.push(['flush', sentinel]);
  }
  stopInference(reason?: string): void {
    this.events.push(['stop_inference', reason]);
  }
  detach(): void {
    this.events.push(['detach', null]);
  }
}

function makeOpts(thresholds?: Record<string, number>): TurnDetectorOptions {
  return { sampleRate: 16000, thresholds: thresholds ?? {} };
}

interface MakeStreamOpts {
  backend?: 'cloud' | 'local';
  userThreshold?: number | Record<string, number>;
  detector?: AudioTurnDetector;
}

function makeStreamWithTransport(
  transport: AudioTurnDetectionTransport,
  opts: MakeStreamOpts = {},
): AudioTurnDetectorStreamImpl {
  const backend = opts.backend ?? 'cloud';
  const detector =
    opts.detector ??
    makeMockDetector(backend, makeOpts(materializeThresholds(opts.userThreshold, backend)));
  const stream = new AudioTurnDetectorStreamImpl({
    detector,
    opts: detector['_opts'] as TurnDetectorOptions,
    cloudOpts:
      backend === 'cloud'
        ? {
            baseUrl: 'ws://test',
            apiKey: 'x',
            apiSecret: 'x',
            connOptions: DEFAULT_API_CONNECT_OPTIONS,
          }
        : undefined,
    backend,
    transport,
  });
  return stream;
}

/** Build an `AudioTurnDetector` for assertions without going through env
 * resolution — useful when we want a specific backend + threshold table for
 * a stream we'll build separately. */
function makeMockDetector(
  backend: 'cloud' | 'local',
  opts: TurnDetectorOptions,
): AudioTurnDetector {
  // Construct via the public constructor, then override the internal
  // backend + threshold view to match what we want for the assertion.
  const originalEnv = { ...process.env };
  if (backend === 'local') {
    delete process.env.LIVEKIT_REMOTE_EOT_URL;
  } else {
    process.env.LIVEKIT_REMOTE_EOT_URL = 'ws://test';
    process.env.LIVEKIT_API_KEY = 'x';
    process.env.LIVEKIT_API_SECRET = 'x';
  }
  const det = new AudioTurnDetector();
  process.env = originalEnv;
  const internals = det as unknown as { _backend: typeof backend; _opts: TurnDetectorOptions };
  internals._backend = backend;
  internals._opts = { ...internals._opts, thresholds: opts.thresholds };
  return det;
}

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const original = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => {
        process.env = original;
      });
    }
    process.env = original;
    return result;
  } catch (err) {
    process.env = original;
    throw err;
  }
}

// Stub `LocalTransport.run` so the fallback FSM doesn't hang on a real
// drain loop. The behavior under test is the swap, not the post-swap I/O.
let runSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  runSpy = vi.spyOn(LocalTransport.prototype, 'run').mockImplementation(async () => undefined);
});
afterEach(() => {
  runSpy.mockRestore();
});

describe('AutoSelect', () => {
  it('selects local when no remote EOT url', () => {
    void withEnv({ LIVEKIT_REMOTE_EOT_URL: undefined }, () => {
      const detector = new AudioTurnDetector();
      expect(detector.backend).toBe('local');
    });
  });

  it('selects cloud when remote EOT url set', () => {
    void withEnv(
      {
        LIVEKIT_REMOTE_EOT_URL: 'ws://gateway',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      },
      () => {
        const detector = new AudioTurnDetector();
        expect(detector.backend).toBe('cloud');
      },
    );
  });

  it('downgrades to local when creds missing', () => {
    void withEnv(
      {
        LIVEKIT_REMOTE_EOT_URL: 'ws://gateway',
        LIVEKIT_API_KEY: undefined,
        LIVEKIT_API_SECRET: undefined,
        LIVEKIT_INFERENCE_API_KEY: undefined,
        LIVEKIT_INFERENCE_API_SECRET: undefined,
      },
      () => {
        const detector = new AudioTurnDetector();
        expect(detector.backend).toBe('local');
      },
    );
  });
});

describe('ExplicitBackendErrors', () => {
  it('explicit cloud missing creds throws', () => {
    void withEnv(
      {
        LIVEKIT_REMOTE_EOT_URL: undefined,
        LIVEKIT_API_KEY: undefined,
        LIVEKIT_API_SECRET: undefined,
        LIVEKIT_INFERENCE_API_KEY: undefined,
        LIVEKIT_INFERENCE_API_SECRET: undefined,
      },
      () => {
        expect(() => new AudioTurnDetector({ backend: 'cloud' })).toThrow();
      },
    );
  });
});

describe('Fallback', () => {
  it('fallback on transport error swaps to local', async () => {
    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new APIConnectionError({ message: 'boom' }),
    });
    const stream = makeStreamWithTransport(transport);
    await waitFor(() => stream.backend === 'local');
    expect(stream.backend).toBe('local');
    expect(stream.isFallback).toBe(true);
    expect(stream.warnedCloudFailure).toBe(true);
    expect(transport.events).toContainEqual(['detach', null]);
    await stream.aclose();
  });

  it('fallback on predict timeout', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport);
    const prob = await stream.predictEndOfTurn(undefined, { timeoutMs: 10 });
    expect(prob).toBe(1.0);
    expect(stream.backend).toBe('local');
    expect(stream.isFallback).toBe(true);
    await stream.aclose();
  });

  it('fallback persists across turns', async () => {
    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new APIConnectionError({ message: 'boom' }),
    });
    const stream = makeStreamWithTransport(transport);
    await waitFor(() => stream.backend === 'local');
    expect(transport.runCalls).toBe(1);
    stream.warmup();
    expect(stream.backend).toBe('local');
    await stream.aclose();
  });
});

describe('MultiStreamOwnership', () => {
  it('multiple streams can coexist', async () => {
    let detector!: AudioTurnDetector;
    withEnv({ LIVEKIT_REMOTE_EOT_URL: undefined }, () => {
      detector = new AudioTurnDetector({ backend: 'local' });
    });
    // Detector no longer enforces single-stream ownership; fallback state lives
    // on the stream itself so multiple streams off the same detector are safe.
    const s1 = detector.stream();
    const s2 = detector.stream();
    await s1.aclose();
    await s2.aclose();
  });
});

describe('DetectorViewReflectsConstructionDefaults', () => {
  it('detector model/backend/threshold stay at construction-time defaults across fallbacks', async () => {
    let detector!: AudioTurnDetector;
    await withEnv(
      {
        LIVEKIT_REMOTE_EOT_URL: 'ws://gateway',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      },
      async () => {
        detector = new AudioTurnDetector({ unlikelyThreshold: 0.5 });
        expect(detector.model).toBe('eot-audio');
        expect(detector.backend).toBe('cloud');
        expect(await detector.unlikelyThreshold('en')).toBeCloseTo(0.5);
      },
    );

    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new APIConnectionError({ message: 'boom' }),
    });
    const stream = new AudioTurnDetectorStreamImpl({
      detector,
      opts: (detector as unknown as { _opts: TurnDetectorOptions })._opts,
      cloudOpts: undefined,
      backend: 'cloud',
      transport,
    });
    await waitFor(() => stream.backend === 'local');

    // The stream reflects the fallback...
    expect(stream.backend).toBe('local');
    expect(stream.model).toBe('eot-audio-mini');
    const expected = LOCAL_LANGUAGES.en! * (0.5 / CLOUD_LANGUAGES.en!);
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(expected);

    // ...but the detector still reports the construction-time defaults: the
    // fallback state lives on the stream, never written back to the detector,
    // so other streams off the same detector aren't corrupted.
    expect(detector.model).toBe('eot-audio');
    expect(detector.backend).toBe('cloud');
    expect(await detector.unlikelyThreshold('en')).toBeCloseTo(0.5);
    await stream.aclose();
  });
});

describe('LocalFailureRetry', () => {
  it('local failure emits default and retries on next turn', async () => {
    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new Error('local boom'),
    });
    const stream = makeStreamWithTransport(transport, { backend: 'local' });
    await waitFor(() => stream.warnedLocalFailure);
    expect(stream.backend).toBe('local');
    expect(stream.isFallback).toBe(false);
    expect(stream.warnedLocalFailure).toBe(true);
    expect(stream.transport).toBe(transport);
    await stream.aclose();
  });
});

describe('WarningDedupe', () => {
  it('cloud→local warning logged once per session', async () => {
    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new APIConnectionError({ message: 'boom' }),
    });
    const stream = makeStreamWithTransport(transport);
    await waitFor(() => stream.backend === 'local');
    // Trigger a second fallback path directly.
    stream._fallBackToLocal(new APIConnectionError({ message: 'boom2' }));
    // Across both invocations only one warning was emitted — tracked by
    // the `warnedCloudFailure` flag staying flipped after the first call.
    expect(stream.warnedCloudFailure).toBe(true);
    await stream.aclose();
  });

  it('local warning logged once per session', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport, { backend: 'local' });
    stream._onLocalFailure(new Error('a'));
    stream._onLocalFailure(new Error('b'));
    expect(stream.warnedLocalFailure).toBe(true);
    await stream.aclose();
  });
});

describe('ThresholdScaling', () => {
  it('cloud user threshold is pass-through pre-stream', async () => {
    await withEnv(
      {
        LIVEKIT_REMOTE_EOT_URL: 'ws://gateway',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      },
      async () => {
        const detector = new AudioTurnDetector({ unlikelyThreshold: 0.5 });
        expect(detector.backend).toBe('cloud');
        const value = await detector.unlikelyThreshold('en');
        expect(value).toBeCloseTo(0.5);
      },
    );
  });

  it('explicit-local user threshold passes through (no rescale)', async () => {
    await withEnv({ LIVEKIT_REMOTE_EOT_URL: undefined }, async () => {
      const detector = new AudioTurnDetector({ backend: 'local', unlikelyThreshold: 0.5 });
      const value = await detector.unlikelyThreshold('en');
      expect(value).toBeCloseTo(0.5);
    });
  });

  it('post-fallback threshold rescales on stream', async () => {
    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new APIConnectionError({ message: 'boom' }),
    });
    const stream = makeStreamWithTransport(transport, { userThreshold: 0.5 });
    await waitFor(() => stream.backend === 'local');
    expect(stream.isFallback).toBe(true);
    const value = await stream.unlikelyThreshold('en');
    const expected = LOCAL_LANGUAGES.en! * (0.5 / CLOUD_LANGUAGES.en!);
    expect(value).toBeCloseTo(expected);
    await stream.aclose();
  });

  it('threshold default unchanged when user threshold not set', async () => {
    await withEnv(
      {
        LIVEKIT_REMOTE_EOT_URL: 'ws://gateway',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      },
      async () => {
        const detector = new AudioTurnDetector();
        const cloudDefault = await detector.unlikelyThreshold('en');
        expect(cloudDefault).toBeCloseTo(CLOUD_LANGUAGES.en!);
      },
    );

    await withEnv({ LIVEKIT_REMOTE_EOT_URL: undefined }, async () => {
      const detector = new AudioTurnDetector();
      const localDefault = await detector.unlikelyThreshold('en');
      expect(localDefault).toBeCloseTo(LOCAL_LANGUAGES.en!);
    });
  });
});

describe('ThresholdDictOverride', () => {
  it('dict override applies per language', async () => {
    await withEnv(
      {
        LIVEKIT_REMOTE_EOT_URL: 'ws://gateway',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      },
      async () => {
        const detector = new AudioTurnDetector({
          unlikelyThreshold: { en: 0.55, ja: 0.25 },
        });
        expect(await detector.unlikelyThreshold('en')).toBeCloseTo(0.55);
        expect(await detector.unlikelyThreshold('ja')).toBeCloseTo(0.25);
        expect(await detector.unlikelyThreshold('fr')).toBeCloseTo(CLOUD_LANGUAGES.fr!);
      },
    );
  });

  it('dict keys normalized via language code', async () => {
    await withEnv({ LIVEKIT_REMOTE_EOT_URL: undefined }, async () => {
      const detector = new AudioTurnDetector({
        unlikelyThreshold: { English: 0.55, 'en-US': 0.55 },
      });
      expect(await detector.unlikelyThreshold('en')).toBeCloseTo(0.55);
    });
  });

  it('dict override rescaled per language on fallback', async () => {
    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new APIConnectionError({ message: 'boom' }),
    });
    const stream = makeStreamWithTransport(transport, {
      userThreshold: { en: 0.55, ja: 0.25 },
    });
    await waitFor(() => stream.backend === 'local');
    expect(stream.isFallback).toBe(true);
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(
      LOCAL_LANGUAGES.en! * (0.55 / CLOUD_LANGUAGES.en!),
    );
    expect(await stream.unlikelyThreshold('ja')).toBeCloseTo(
      LOCAL_LANGUAGES.ja! * (0.25 / CLOUD_LANGUAGES.ja!),
    );
    expect(await stream.unlikelyThreshold('fr')).toBeCloseTo(LOCAL_LANGUAGES.fr!);
    await stream.aclose();
  });
});

describe('LocalBackendExecutor', () => {
  function pcmFrame(samples = 320): AudioFrame {
    return new AudioFrame(new Int16Array(samples), 16000, 1, samples);
  }

  it('routes local predict through the injected executor (base64 PCM)', async () => {
    const doInference = vi.fn(async (method: string, data: unknown) => {
      expect(method).toBe(EOT_INFERENCE_METHOD);
      expect(typeof (data as { pcm: string }).pcm).toBe('string');
      return { probability: 0.7, inferenceDurationMs: 5 };
    });
    const executor: InferenceExecutor = { doInference };
    const detector = new AudioTurnDetector({ backend: 'local', executor });
    const stream = detector.stream();
    try {
      stream.pushAudio(pcmFrame());
      const p = await stream.predictEndOfTurn(undefined, { timeoutMs: 1000 });
      expect(p).toBe(0.7);
      expect(doInference).toHaveBeenCalledWith(EOT_INFERENCE_METHOD, expect.anything());
    } finally {
      await stream.aclose();
    }
  });

  it('degrades to a positive default when no executor is available', async () => {
    // explicit undefined → constructor falls through to getJobContext()
    // (throws outside a job) → executor stays undefined.
    const detector = new AudioTurnDetector({ backend: 'local', executor: undefined });
    const stream = detector.stream();
    try {
      const p = await stream.predictEndOfTurn(undefined, { timeoutMs: 1000 });
      expect(p).toBe(1.0);
    } finally {
      await stream.aclose();
    }
  });
});
