// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * License-mode Krisp internals.
 *
 * This module is private to the plugin. It wraps the public
 * `krisp-audio-node-sdk` and exposes a {@link KrispLicenseFrameProcessor} that
 * {@link krispVivaFilter} instantiates when the user picks
 * {@link KrispLicenseAuthProvider}.
 *
 * Wires the documented `krisp-audio-node-sdk` surface (https://sdk-docs.krisp.ai):
 * global init with a working-directory path, the `enums.SamplingRate` and
 * `enums.FrameDuration` tables, `NcInt16.create(config)`, per-frame `process`,
 * and the session/global destroy calls. The license key is supplied out-of-band
 * via `KRISP_VIVA_SDK_LICENSE_KEY` (read by the native SDK); the documented
 * `globalInit` takes only a working-directory path.
 *
 * The frame buffering / reframing logic is ported from the Python plugin.
 */
import { AudioFrame, FrameProcessor } from '@livekit/rtc-node';
import { createRequire } from 'node:module';
import { log } from './log.js';

const require = createRequire(import.meta.url);

const SUPPORTED_SAMPLE_RATES = [8000, 16000, 24000, 32000, 44100, 48000] as const;
const SUPPORTED_FRAME_DURATIONS_MS = [10, 15, 20, 30, 32] as const;

/** Map a sample rate (Hz) to the SDK's `enums.SamplingRate.Sr<rate>Hz` member. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function samplingRateEnum(mod: any, sampleRate: number): unknown {
  const value = mod.enums?.SamplingRate?.[`Sr${sampleRate}Hz`];
  if (value === undefined) {
    throw new Error(
      `Unsupported sample rate: ${sampleRate} Hz. ` +
        `Supported rates: ${SUPPORTED_SAMPLE_RATES.join(', ')} Hz`,
    );
  }
  return value;
}

/** Map a frame duration (ms) to the SDK's `enums.FrameDuration.Fd<ms>ms` member. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function frameDurationEnum(mod: any, frameDurationMs: number): unknown {
  const value = mod.enums?.FrameDuration?.[`Fd${frameDurationMs}ms`];
  if (value === undefined) {
    throw new Error(
      `Unsupported frame duration: ${frameDurationMs} ms. ` +
        `Supported durations: ${SUPPORTED_FRAME_DURATIONS_MS.join(', ')} ms`,
    );
  }
  return value;
}

/**
 * Process-singleton ref counter for the proprietary `krisp-audio-node-sdk`.
 *
 * Krisp's `globalInit` / `globalDestroy` are process-global, so this manager
 * keeps a single SDK alive across multiple license-mode frame processors. The
 * module is lazy-required on first acquire — never loaded in cloud-only
 * deployments.
 */
class KrispLicenseSdkManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static module: any = null;
  private static referenceCount = 0;

  /** Acquire a reference, returning the loaded `krisp-audio-node-sdk` module. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static acquire(): any {
    if (this.referenceCount === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mod: any;
      try {
        mod = require('krisp-audio-node-sdk');
      } catch {
        throw new Error(
          'krisp-audio-node-sdk is not installed. Install the public Krisp Node SDK ' +
            '(`pnpm add krisp-audio-node-sdk`) and provide a .kef model, or use the ' +
            'default LiveKit Cloud auth provider (auth.livekitCloud()).',
        );
      }

      // The license key is read from KRISP_VIVA_SDK_LICENSE_KEY by the native SDK;
      // the documented globalInit only takes a working-directory path.
      mod.globalInit('');

      this.module = mod;
      log().debug('Krisp Audio SDK (license) initialized');
    }
    this.referenceCount += 1;
    log().debug(`Krisp SDK (license) reference count: ${this.referenceCount}`);
    return this.module;
  }

  /** Release a reference, destroying the SDK on the last release. */
  static release(): void {
    if (this.referenceCount === 0) {
      return;
    }
    this.referenceCount -= 1;
    log().debug(`Krisp SDK (license) reference count: ${this.referenceCount}`);
    if (this.referenceCount === 0 && this.module !== null) {
      try {
        this.module.globalDestroy();
        log().debug('Krisp Audio SDK (license) destroyed');
      } catch (e) {
        log().error(`Error during Krisp SDK cleanup: ${e}`);
      } finally {
        this.module = null;
      }
    }
  }
}

function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function clampLevel(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export interface KrispLicenseFrameProcessorOptions {
  modelPath: string;
  noiseSuppressionLevel: number;
  frameDurationMs: number;
}

/**
 * License-mode FrameProcessor wrapping `krisp-audio-node-sdk`.
 *
 * Internal implementation detail — users call `vivaFilter()` and the facade
 * selects this when the auth provider is {@link KrispLicenseAuthProvider}.
 *
 * The buffering strategy mirrors the Python plugin: Krisp processes fixed-size
 * chunks (`frameDurationMs` worth of samples) but input frames may arrive at any
 * size, so incoming samples accumulate in {@link inBuf}, are processed one whole
 * chunk at a time, and results queue in {@link outBuf} so each call emits exactly
 * as many samples as it received (zero-padded during the brief warm-up).
 */
export class KrispLicenseFrameProcessor extends FrameProcessor<AudioFrame> {
  private enabled = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private module: any;
  private sdkAcquired = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;
  private level: number;
  private readonly frameDurationMs: number;
  private readonly modelPath: string;
  private sampleRate: number | null = null;
  private chunkSamples: number | null = null;
  private warnedChannels = false;
  private inBuf: Int16Array = new Int16Array(0);
  private outBuf: Int16Array = new Int16Array(0);

  constructor(opts: KrispLicenseFrameProcessorOptions) {
    super();
    this.level = clampLevel(opts.noiseSuppressionLevel);
    this.frameDurationMs = opts.frameDurationMs;
    this.modelPath = opts.modelPath;

    if (!SUPPORTED_FRAME_DURATIONS_MS.includes(this.frameDurationMs as never)) {
      throw new Error(
        `Unsupported frame duration: ${this.frameDurationMs} ms. ` +
          `Supported durations: ${SUPPORTED_FRAME_DURATIONS_MS.join(', ')} ms`,
      );
    }

    this.module = KrispLicenseSdkManager.acquire();
    this.sdkAcquired = true;

    try {
      // Pre-load the model now to fail fast on a bad license/model path. The
      // session is recreated automatically if the first frame arrives at a
      // different sample rate.
      this.createSession(16000);
      log().info('Krisp license frame processor initialized (adapts to input sample rate)');
    } catch (e) {
      this.teardown();
      throw e;
    }
  }

  private createSession(sampleRate: number): void {
    if (this.session !== null && this.sampleRate === sampleRate) {
      return;
    }
    if (!SUPPORTED_SAMPLE_RATES.includes(sampleRate as never)) {
      throw new Error(
        `Unsupported sample rate: ${sampleRate} Hz. ` +
          `Supported rates: ${SUPPORTED_SAMPLE_RATES.join(', ')} Hz`,
      );
    }

    log().info(`Creating Krisp session for sample rate: ${sampleRate}Hz`);

    // Free the previous session (if any) before replacing it on a rate change.
    if (this.session !== null) {
      try {
        this.session.destroy();
      } catch (e) {
        log().error(`Error destroying Krisp session: ${e}`);
      }
      this.session = null;
    }

    // Int16 noise-cancellation session. Our AudioFrame samples are int16 PCM, so
    // NcInt16 avoids a float round-trip (the docs' Node example shows the NcFloat
    // sibling). Output sample rate is pinned to the input rate — we only filter.
    const inputSampleRate = samplingRateEnum(this.module, sampleRate);
    const config = {
      inputSampleRate,
      inputFrameDuration: frameDurationEnum(this.module, this.frameDurationMs),
      outputSampleRate: inputSampleRate,
      modelInfo: { path: this.modelPath },
    };
    this.session = this.module.NcInt16.create(config);
    this.sampleRate = sampleRate;
    this.chunkSamples = Math.floor((sampleRate * this.frameDurationMs) / 1000);
    // The pending/processed buffers belong to the old rate; start fresh.
    this.inBuf = new Int16Array(0);
    this.outBuf = new Int16Array(0);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get noiseSuppressionLevel(): number {
    return this.level;
  }

  setNoiseSuppressionLevel(value: number): void {
    // Applied on the next processed frame — the level is passed per-call to the
    // Krisp session, so no session recreation is needed.
    this.level = clampLevel(value);
  }

  process(frame: AudioFrame): AudioFrame {
    if (!this.enabled) {
      return frame;
    }

    if (frame.channels !== 1) {
      if (!this.warnedChannels) {
        log().warn(
          `Krisp filter not applied: expected mono audio but got ${frame.channels} ` +
            'channels; frames are passed through unprocessed.',
        );
        this.warnedChannels = true;
      }
      return frame;
    }

    // Adapt to the input sample rate, recreating the session on a change.
    if (this.session === null || this.sampleRate !== frame.sampleRate) {
      this.createSession(frame.sampleRate);
    }

    const chunk = this.chunkSamples!;

    // Accumulate the incoming samples and process every whole chunk available.
    this.inBuf = concatInt16(this.inBuf, frame.data);

    const nChunks = Math.floor(this.inBuf.length / chunk);
    if (nChunks > 0) {
      const consumed = nChunks * chunk;
      const pending = this.inBuf.subarray(0, consumed);
      this.inBuf = this.inBuf.slice(consumed);

      for (let i = 0; i < nChunks; i++) {
        const chunkIn = pending.subarray(i * chunk, (i + 1) * chunk);
        let chunkOut: Int16Array;
        try {
          chunkOut = this.session.process(chunkIn, this.level);
        } catch (e) {
          log().error(`Error processing frame: ${e}`);
          chunkOut = chunkIn;
        }
        if (!chunkOut || chunkOut.length !== chunk) {
          log().warn('Krisp returned unexpected output, using original audio');
          chunkOut = chunkIn;
        }
        this.outBuf = concatInt16(this.outBuf, chunkOut);
      }
    }

    // Emit exactly as many samples as we received this call. Before the first
    // full chunk is ready the deficit is zero-padded; samples in and out stay
    // balanced over time, so there is no drift.
    const n = frame.samplesPerChannel;
    let out: Int16Array;
    if (this.outBuf.length >= n) {
      out = this.outBuf.slice(0, n);
      this.outBuf = this.outBuf.slice(n);
    } else {
      out = new Int16Array(n);
      out.set(this.outBuf, n - this.outBuf.length);
      this.outBuf = new Int16Array(0);
    }

    return new AudioFrame(out, frame.sampleRate, frame.channels, out.length);
  }

  private teardown(): void {
    if (this.session !== null) {
      try {
        this.session.destroy();
      } catch (e) {
        log().error(`Error destroying Krisp session: ${e}`);
      }
      this.session = null;
    }
    this.inBuf = new Int16Array(0);
    this.outBuf = new Int16Array(0);
    if (this.sdkAcquired) {
      KrispLicenseSdkManager.release();
      this.sdkAcquired = false;
    }
  }

  close(): void {
    this.teardown();
    log().debug('Krisp license frame processor closed');
  }
}
