// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * License-mode Krisp internals.
 *
 * This module is private to the plugin. It wraps the public
 * `@krisp/viva-node-sdk` and exposes a {@link KrispLicenseFrameProcessor} that
 * {@link krispVivaFilter} instantiates when the user picks
 * {@link KrispLicenseAuthProvider}.
 *
 * Wires the documented `@krisp/viva-node-sdk` surface (https://sdk-docs.krisp.ai):
 * `globalInit(workingDir, licenseKey)`, the `enums.SamplingRate` and
 * `enums.FrameDuration` tables, `NcInt16.create(config)`, per-frame `process`
 * (byte `Buffer` in and out), and the session/global destroy calls. The license
 * key is read from `KRISP_VIVA_SDK_LICENSE_KEY` and passed to `globalInit`.
 *
 * The frame buffering / reframing logic is ported from the Python plugin.
 */
import type { KrispEnumMember, KrispModule, KrispNcSession } from '@krisp/viva-node-sdk';
import { AudioFrame, FrameProcessor } from '@livekit/rtc-node';
import { createRequire } from 'node:module';
import { log } from './log.js';

const require = createRequire(import.meta.url);

const SUPPORTED_SAMPLE_RATES: Array<number> = [8000, 16000, 24000, 32000, 44100, 48000] as const;
const SUPPORTED_FRAME_DURATIONS_MS: Array<number> = [10, 15, 20, 30, 32] as const;

/** Map a sample rate (Hz) to the SDK's `enums.SamplingRate.Sr<rate>Hz` member. */
function samplingRateEnum(mod: KrispModule, sampleRate: number): KrispEnumMember {
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
function frameDurationEnum(mod: KrispModule, frameDurationMs: number): KrispEnumMember {
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
 * Process-singleton ref counter for the proprietary `@krisp/viva-node-sdk`.
 *
 * Krisp's `globalInit` / `globalDestroy` are process-global, so this manager
 * keeps a single SDK alive across multiple license-mode frame processors. The
 * module is lazy-required on first acquire — never loaded in cloud-only
 * deployments.
 */
class KrispLicenseSdkManager {
  private static module: KrispModule | null = null;
  private static referenceCount = 0;

  /** Acquire a reference, returning the loaded `@krisp/viva-node-sdk` module. */
  static acquire(): KrispModule {
    if (this.referenceCount === 0) {
      let mod: KrispModule;
      try {
        mod = require('@krisp/viva-node-sdk');
      } catch {
        throw new Error(
          '@krisp/viva-node-sdk is not installed. Install the proprietary Krisp Node SDK ' +
            '(`pnpm add @krisp/viva-node-sdk`) and provide a .kef model, or use the ' +
            'default LiveKit Cloud auth provider (auth.livekitCloud()).',
        );
      }

      // Working dir '' uses the SDK default; the license key comes from the
      // environment (KRISP_VIVA_SDK_LICENSE_KEY) and is passed to globalInit.
      const licenseKey = process.env.KRISP_VIVA_SDK_LICENSE_KEY;
      if (licenseKey) {
        mod.globalInit('', licenseKey);
      } else {
        mod.globalInit('');
      }

      this.module = mod;
      log().debug('Krisp Audio SDK (license) initialized');
    }
    this.referenceCount += 1;
    log().debug(`Krisp SDK (license) reference count: ${this.referenceCount}`);
    // Non-null once refCount > 0: release() only nulls the module at refCount 0.
    return this.module!;
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

/**
 * Reinterpret a byte buffer of interleaved int16 PCM as an `Int16Array`. Copies
 * into a fresh, 2-byte-aligned buffer — a native-returned `Buffer` may sit at an
 * odd `byteOffset` in a pooled `ArrayBuffer`, which a zero-copy `Int16Array`
 * view cannot represent.
 */
function bufferToInt16(buf: Buffer): Int16Array {
  const usableBytes = buf.byteLength - (buf.byteLength % 2);
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + usableBytes);
  return new Int16Array(copy);
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
 * License-mode FrameProcessor wrapping `@krisp/viva-node-sdk`.
 *
 * Internal implementation detail — users call `vivaFilter()` and the facade
 * selects this when the auth provider is {@link KrispLicenseAuthProvider}.
 *
 * The buffering strategy mirrors the Python plugin: Krisp processes fixed-size
 * chunks (`frameDurationMs` worth of samples) but input frames may arrive at any
 * size, so incoming samples accumulate in {@link inBuf}, are processed one whole
 * chunk at a time, and results queue in {@link outBuf}. Each call emits whatever
 * processed audio is ready (never zero-padded — see {@link process}), so the
 * output frame size floats and real audio is never interrupted by silence.
 */
export class KrispLicenseFrameProcessor extends FrameProcessor<AudioFrame> {
  private enabled = true;

  private sdkAcquired = false;
  private module: KrispModule;
  private session: KrispNcSession | null = null;
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

    if (!SUPPORTED_FRAME_DURATIONS_MS.includes(this.frameDurationMs)) {
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
          // The SDK takes/returns byte buffers of interleaved int16 PCM, so wrap
          // the input samples as a Buffer view and reinterpret the returned
          // Buffer's bytes as int16 samples (its `.length` is bytes = samples×2).
          const inputBuf = Buffer.from(chunkIn.buffer, chunkIn.byteOffset, chunkIn.byteLength);
          // Non-null: the guard above (re)creates the session or throws.
          const outputBuf = this.session!.process(inputBuf, this.level);
          chunkOut = bufferToInt16(outputBuf);
        } catch (e) {
          log().error(`Error processing frame: ${e}`);
          chunkOut = chunkIn;
        }
        if (chunkOut.length !== chunk) {
          log().warn(
            `Krisp returned ${chunkOut.length} samples, expected ${chunk}; using original audio`,
          );
          chunkOut = chunkIn;
        }
        this.outBuf = concatInt16(this.outBuf, chunkOut);
      }
    }

    // Emit the processed audio that is ready, keeping any surplus buffered for
    // the next call. We never zero-pad a deficit: doing so injects silence
    // *between* real audio (which recurs whenever the input frame size isn't a
    // multiple of the chunk size) and surfaces as audible gaps once frames are
    // concatenated downstream. Instead the output frame size floats — up to a
    // full chunk of latency at the start (and an empty frame if the buffer is
    // momentarily starved), both of which downstream reframing handles fine —
    // so real audio is never interrupted.
    const n = frame.samplesPerChannel;
    const k = Math.min(n, this.outBuf.length);
    const out = this.outBuf.slice(0, k);
    this.outBuf = this.outBuf.slice(k);

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
