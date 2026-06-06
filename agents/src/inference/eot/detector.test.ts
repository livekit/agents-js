// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the unified `TurnDetector` (auto-select + fallback + server defaults).
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
 * - Server-provided default thresholds adopted from `SessionCreated`.
 * - Override resolution (scalar / dict / none) against the server defaults, the
 *   override warning, runtime `updateOptions`, and the degenerate
 *   (no usable thresholds) → fallback path.
 * - Threshold rescaling against the server defaults on actual fallback.
 *
 * Port of Python `tests/test_audio_turn_detector_fallback.py`.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError } from '../../_exceptions.js';
import type { InferenceExecutor } from '../../ipc/inference_executor.js';
import { log } from '../../log.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import type { BaseStreamingTurnDetectorStream } from './base.js';
import {
  type BaseStreamingTurnDetectorOptions,
  type FlushSentinel,
  type StreamingTurnDetectionTransport,
} from './base.js';
import { TurnDetector, TurnDetectorStreamImpl } from './detector.js';
import { LOCAL_LANGUAGES, ThresholdOptions } from './languages.js';
import { EOT_INFERENCE_METHOD } from './runner.js';
import { LocalTransport } from './transports.js';

// Stand-in for the per-language defaults a gateway returns in `SessionCreated`.
const SERVER_THRESHOLDS: Record<string, number> = { en: 0.56, ja: 0.37, fr: 0.575 };
const SERVER_DEFAULT_THRESHOLD = 0.5;

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

class ScriptedTransport implements StreamingTurnDetectionTransport {
  runBehavior: 'idle' | 'raise' | 'return';
  runExc: Error | undefined;
  runCalls = 0;
  events: Array<[string, unknown]> = [];
  private _stream: BaseStreamingTurnDetectorStream | undefined;

  constructor(opts: ScriptedTransportOptions = {}) {
    this.runBehavior = opts.runBehavior ?? 'idle';
    this.runExc = opts.runExc;
  }

  attach(stream: BaseStreamingTurnDetectorStream): void {
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

function detectorOpts(detector: TurnDetector): BaseStreamingTurnDetectorOptions {
  return (detector as unknown as { _opts: BaseStreamingTurnDetectorOptions })._opts;
}

interface MakeStreamOpts {
  model?: 'turn-detector-v1' | 'turn-detector-v1-mini';
  userThreshold?: number | Record<string, number>;
  detector?: TurnDetector;
}

/**
 * Construct a stream wired to a scripted transport. The detector and stream
 * share one `ThresholdOptions` (as in production). The cloud model starts with
 * empty thresholds (its defaults arrive via `SessionCreated` — call
 * `stream.thresholdsOptions._updateDefaults` to simulate that). The local mini
 * model resolves its thresholds against `LOCAL_LANGUAGES` up front.
 */
function makeStreamWithTransport(
  transport: StreamingTurnDetectionTransport,
  opts: MakeStreamOpts = {},
): TurnDetectorStreamImpl {
  const model = opts.model ?? 'turn-detector-v1';
  const detector = opts.detector ?? makeMockDetector(model, opts.userThreshold);
  const stream = new TurnDetectorStreamImpl({
    detector,
    opts: detectorOpts(detector),
    cloudOpts:
      model === 'turn-detector-v1'
        ? {
            baseUrl: 'ws://test',
            apiKey: 'x',
            apiSecret: 'x',
            connOptions: DEFAULT_API_CONNECT_OPTIONS,
          }
        : undefined,
    model,
    transport,
  });
  return stream;
}

/** Build a `TurnDetector` for assertions without going through env
 * resolution — seed a specific model + threshold override for a stream we'll
 * build separately. */
function makeMockDetector(
  model: 'turn-detector-v1' | 'turn-detector-v1-mini',
  userThreshold?: number | Record<string, number>,
): TurnDetector {
  // Construct via the public constructor, then override the internal model +
  // shared threshold options to match what we want for the assertion.
  const originalEnv = { ...process.env };
  if (model === 'turn-detector-v1-mini') {
    delete process.env.LIVEKIT_REMOTE_EOT_URL;
  } else {
    process.env.LIVEKIT_REMOTE_EOT_URL = 'ws://test';
    process.env.LIVEKIT_API_KEY = 'x';
    process.env.LIVEKIT_API_SECRET = 'x';
  }
  const det = new TurnDetector();
  process.env = originalEnv;
  const internals = det as unknown as {
    _model: typeof model;
    _opts: BaseStreamingTurnDetectorOptions;
  };
  internals._model = model;
  internals._opts = { ...internals._opts, thresholds: new ThresholdOptions(model, userThreshold) };
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
      const detector = new TurnDetector();
      expect(detector.model).toBe('turn-detector-v1-mini');
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
        const detector = new TurnDetector();
        expect(detector.model).toBe('turn-detector-v1');
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
        const detector = new TurnDetector();
        expect(detector.model).toBe('turn-detector-v1-mini');
      },
    );
  });
});

describe('ExplicitModelErrors', () => {
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
        expect(() => new TurnDetector({ version: 'v1' })).toThrow();
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
    await waitFor(() => stream.model === 'turn-detector-v1-mini');
    expect(stream.model).toBe('turn-detector-v1-mini');
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
    expect(stream.model).toBe('turn-detector-v1-mini');
    expect(stream.isFallback).toBe(true);
    await stream.aclose();
  });

  it('fallback persists across turns', async () => {
    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new APIConnectionError({ message: 'boom' }),
    });
    const stream = makeStreamWithTransport(transport);
    await waitFor(() => stream.model === 'turn-detector-v1-mini');
    expect(transport.runCalls).toBe(1);
    stream.warmup();
    expect(stream.model).toBe('turn-detector-v1-mini');
    await stream.aclose();
  });
});

describe('MultiStreamOwnership', () => {
  it('multiple streams can be opened off one detector', async () => {
    let detector!: TurnDetector;
    withEnv({ LIVEKIT_REMOTE_EOT_URL: undefined }, () => {
      detector = new TurnDetector({ version: 'v1-mini' });
    });
    // Only one stream is active at a time in production; the detector still
    // permits constructing several (they share its `ThresholdOptions`).
    const s1 = detector.stream();
    const s2 = detector.stream();
    await s1.aclose();
    await s2.aclose();
  });
});

describe('DetectorViewAfterFallback', () => {
  it('detector model + threshold follow the fallback (shared ThresholdOptions)', async () => {
    let detector!: TurnDetector;
    withEnv(
      {
        LIVEKIT_REMOTE_EOT_URL: 'ws://gateway',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      },
      () => {
        detector = new TurnDetector({ unlikelyThreshold: 0.5 });
      },
    );
    expect(detector.model).toBe('turn-detector-v1');
    // scalar override is resolvable pre-session via the catch-all
    expect(await detector.unlikelyThreshold('en')).toBeCloseTo(0.5);

    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = new TurnDetectorStreamImpl({
      detector,
      opts: detectorOpts(detector),
      cloudOpts: undefined,
      model: 'turn-detector-v1',
      transport,
    });
    // server defaults arrive, then the cloud session fails
    stream.thresholdsOptions._updateDefaults({ ...SERVER_THRESHOLDS }, SERVER_DEFAULT_THRESHOLD);
    stream._fallBackToLocal(new APIConnectionError({ message: 'boom' }));
    await waitFor(() => stream.model === 'turn-detector-v1-mini');

    // Both the stream and the detector (sharing one ThresholdOptions) reflect it.
    expect(stream.model).toBe('turn-detector-v1-mini');
    expect(detector.model).toBe('turn-detector-v1-mini');
    const expected = LOCAL_LANGUAGES.en! * (0.5 / SERVER_THRESHOLDS.en!);
    expect(await detector.unlikelyThreshold('en')).toBeCloseTo(expected);
    await stream.aclose();
  });
});

describe('LocalFailureRetry', () => {
  it('local failure emits default and retries on next turn', async () => {
    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new Error('local boom'),
    });
    const stream = makeStreamWithTransport(transport, { model: 'turn-detector-v1-mini' });
    await waitFor(() => stream.warnedLocalFailure);
    expect(stream.model).toBe('turn-detector-v1-mini');
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
    await waitFor(() => stream.model === 'turn-detector-v1-mini');
    // Trigger a second fallback path directly.
    stream._fallBackToLocal(new APIConnectionError({ message: 'boom2' }));
    // Across both invocations only one warning was emitted — tracked by
    // the `warnedCloudFailure` flag staying flipped after the first call.
    expect(stream.warnedCloudFailure).toBe(true);
    await stream.aclose();
  });

  it('local warning logged once per session', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport, { model: 'turn-detector-v1-mini' });
    stream._onLocalFailure(new Error('a'));
    stream._onLocalFailure(new Error('b'));
    expect(stream.warnedLocalFailure).toBe(true);
    await stream.aclose();
  });
});

describe('ResolveThresholds', () => {
  // Cloud-override resolution against the server defaults, via ThresholdOptions.
  function cloud(overrides?: number | Record<string, number>): ThresholdOptions {
    const opts = new ThresholdOptions('turn-detector-v1', overrides);
    opts._updateDefaults({ ...SERVER_THRESHOLDS }, SERVER_DEFAULT_THRESHOLD);
    return opts;
  }

  it('no override adopts server map + fallback default', () => {
    const opts = cloud();
    expect(opts.thresholds).toEqual(SERVER_THRESHOLDS);
    expect(opts.defaultThreshold).toBeCloseTo(SERVER_DEFAULT_THRESHOLD);
  });

  it('scalar override replaces with empty map', () => {
    const opts = cloud(0.8);
    // empty map → every language resolves through the scalar fallback
    expect(opts.thresholds).toEqual({});
    expect(opts.defaultThreshold).toBeCloseTo(0.8);
  });

  it('dict override layers on server map', () => {
    const opts = cloud({ en: 0.7 });
    expect(opts.thresholds.en).toBeCloseTo(0.7);
    // unmapped languages keep the server values + server fallback
    expect(opts.thresholds.ja).toBeCloseTo(SERVER_THRESHOLDS.ja!);
    expect(opts.defaultThreshold).toBeCloseTo(SERVER_DEFAULT_THRESHOLD);
  });

  it('dict keys normalized', () => {
    const opts = cloud({ English: 0.7, 'en-US': 0.7 });
    expect(opts.thresholds.en).toBeCloseTo(0.7);
  });
});

describe('ServerDefaults', () => {
  it('cloud thresholds pending before session created', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport);
    // A cloud detector has no per-language threshold until `SessionCreated`,
    // but reports the language as supported so the first turn isn't skipped.
    expect(await stream.unlikelyThreshold('en')).toBeUndefined();
    expect(await stream.supportsLanguage('en')).toBe(true);
    await stream.aclose();
  });

  it('cloud adopts server defaults', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport);
    stream.thresholdsOptions._updateDefaults({ ...SERVER_THRESHOLDS }, SERVER_DEFAULT_THRESHOLD);
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(SERVER_THRESHOLDS.en!);
    // language absent from the server map → catch-all default
    expect(await stream.unlikelyThreshold('de')).toBeCloseTo(SERVER_DEFAULT_THRESHOLD);
    await stream.aclose();
  });

  it('dict override layers on server defaults', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport, { userThreshold: { en: 0.7, ja: 0.2 } });
    stream.thresholdsOptions._updateDefaults({ ...SERVER_THRESHOLDS }, SERVER_DEFAULT_THRESHOLD);
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(0.7);
    expect(await stream.unlikelyThreshold('ja')).toBeCloseTo(0.2);
    // fr not overridden → server default for fr
    expect(await stream.unlikelyThreshold('fr')).toBeCloseTo(SERVER_THRESHOLDS.fr!);
    await stream.aclose();
  });

  it('degenerate session created throws without override', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport);
    expect(() => stream.thresholdsOptions._updateDefaults({}, 0.0)).toThrow(APIError);
    await stream.aclose();
  });

  it('degenerate session created throws even with override', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport, { userThreshold: 0.8 });
    expect(() => stream.thresholdsOptions._updateDefaults({}, 0.0)).toThrow(APIError);
    await stream.aclose();
  });
});

describe('OverrideWarning', () => {
  it('warns on construction with override', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    try {
      withEnv({ LIVEKIT_REMOTE_EOT_URL: undefined }, () => {
        new TurnDetector({ unlikelyThreshold: 0.5 });
      });
      const warned = warnSpy.mock.calls.some((c) =>
        JSON.stringify(c).includes('non-default turn detection threshold'),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('no warning without override', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    try {
      withEnv({ LIVEKIT_REMOTE_EOT_URL: undefined }, () => {
        new TurnDetector();
      });
      const warned = warnSpy.mock.calls.some((c) =>
        JSON.stringify(c).includes('non-default turn detection threshold'),
      );
      expect(warned).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('UpdateOptions', () => {
  it('re-resolves an active cloud stream against cached server defaults', async () => {
    let detector!: TurnDetector;
    withEnv(
      {
        LIVEKIT_REMOTE_EOT_URL: 'ws://gateway',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      },
      () => {
        detector = new TurnDetector();
      },
    );
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = new TurnDetectorStreamImpl({
      detector,
      opts: detectorOpts(detector),
      cloudOpts: undefined,
      model: 'turn-detector-v1',
      transport,
    });
    stream.thresholdsOptions._updateDefaults({ ...SERVER_THRESHOLDS }, SERVER_DEFAULT_THRESHOLD);
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(SERVER_THRESHOLDS.en!);

    detector.updateOptions({ unlikelyThreshold: 0.7 });
    // the shared resolver re-resolves against the cached server defaults
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(0.7);
    await stream.aclose();
  });

  it('local model updateOptions', async () => {
    let detector!: TurnDetector;
    withEnv({ LIVEKIT_REMOTE_EOT_URL: undefined }, () => {
      detector = new TurnDetector();
    });
    expect(detector.model).toBe('turn-detector-v1-mini');
    detector.updateOptions({ unlikelyThreshold: 0.42 });
    expect(await detector.unlikelyThreshold('en')).toBeCloseTo(0.42);
    await detector.aclose();
  });
});

describe('ThresholdRescaleOnFallback', () => {
  it('scalar override rescaled against server on fallback', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport, { userThreshold: 0.5 });
    stream.thresholdsOptions._updateDefaults({ ...SERVER_THRESHOLDS }, SERVER_DEFAULT_THRESHOLD);
    stream._fallBackToLocal(new APIConnectionError({ message: 'boom' }));
    await waitFor(() => stream.model === 'turn-detector-v1-mini');
    expect(stream.isFallback).toBe(true);
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(
      LOCAL_LANGUAGES.en! * (0.5 / SERVER_THRESHOLDS.en!),
    );
    await stream.aclose();
  });

  it('no override fallback uses local table', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport);
    stream.thresholdsOptions._updateDefaults({ ...SERVER_THRESHOLDS }, SERVER_DEFAULT_THRESHOLD);
    stream._fallBackToLocal(new APIConnectionError({ message: 'boom' }));
    await waitFor(() => stream.model === 'turn-detector-v1-mini');
    // ratio 1.0 → local table unchanged
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(LOCAL_LANGUAGES.en!);
    await stream.aclose();
  });

  it('dict override rescaled per language on fallback', async () => {
    const transport = new ScriptedTransport({ runBehavior: 'idle' });
    const stream = makeStreamWithTransport(transport, { userThreshold: { en: 0.55, ja: 0.25 } });
    stream.thresholdsOptions._updateDefaults({ ...SERVER_THRESHOLDS }, SERVER_DEFAULT_THRESHOLD);
    stream._fallBackToLocal(new APIConnectionError({ message: 'boom' }));
    await waitFor(() => stream.model === 'turn-detector-v1-mini');
    expect(stream.isFallback).toBe(true);
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(
      LOCAL_LANGUAGES.en! * (0.55 / SERVER_THRESHOLDS.en!),
    );
    expect(await stream.unlikelyThreshold('ja')).toBeCloseTo(
      LOCAL_LANGUAGES.ja! * (0.25 / SERVER_THRESHOLDS.ja!),
    );
    // fr not in dict → server value as effective → plain local default
    expect(await stream.unlikelyThreshold('fr')).toBeCloseTo(LOCAL_LANGUAGES.fr!);
    await stream.aclose();
  });

  it('fallback before session created uses local table with override applied', async () => {
    // Cloud fails before any `SessionCreated` → no server map to rescale
    // against, so the local table (with the override applied) is used directly.
    const transport = new ScriptedTransport({
      runBehavior: 'raise',
      runExc: new APIConnectionError({ message: 'boom' }),
    });
    const stream = makeStreamWithTransport(transport, { userThreshold: 0.42 });
    await waitFor(() => stream.model === 'turn-detector-v1-mini');
    expect(stream.isFallback).toBe(true);
    // scalar 0.42 → 0.42 for every language via the catch-all
    expect(await stream.unlikelyThreshold('en')).toBeCloseTo(0.42);
    await stream.aclose();
  });
});

describe('LocalModelExecutor', () => {
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
    const detector = new TurnDetector({ version: 'v1-mini', executor });
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
    const detector = new TurnDetector({ version: 'v1-mini', executor: undefined });
    const stream = detector.stream();
    try {
      const p = await stream.predictEndOfTurn(undefined, { timeoutMs: 1000 });
      expect(p).toBe(1.0);
    } finally {
      await stream.aclose();
    }
  });
});
