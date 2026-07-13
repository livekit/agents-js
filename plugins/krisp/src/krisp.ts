// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, FrameProcessor } from '@livekit/rtc-node';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type KrispAudioModule = {
  globalInit: (
    configPath: string,
    licenseKey: string,
    licensingErrorCallback: (error: unknown, message: string) => void,
    logCallback: (message: string, level: unknown) => void,
    logLevel: unknown,
  ) => void;
  globalDestroy: () => void;
  getVersion?: () => { major: number; minor: number; patch: number };
  LogLevel: { Off: unknown };
  SamplingRate: Record<string, unknown>;
  FrameDuration: Record<string, unknown>;
  ModelInfo: new () => { path: string };
  NcSessionConfig: new () => {
    inputSampleRate: unknown;
    inputFrameDuration: unknown;
    outputSampleRate: unknown;
    modelInfo: unknown;
  };
  NcInt16: {
    create: (config: unknown) => KrispSession;
  };
};

type KrispSession = {
  process: (
    chunk: Int16Array<ArrayBuffer>,
    level: number,
  ) => Int16Array<ArrayBufferLike> | ArrayLike<number> | null;
};

const SAMPLE_RATES = new Map([
  [8000, 'Sr8000Hz'],
  [16000, 'Sr16000Hz'],
  [24000, 'Sr24000Hz'],
  [32000, 'Sr32000Hz'],
  [44100, 'Sr44100Hz'],
  [48000, 'Sr48000Hz'],
]);

const FRAME_DURATIONS = new Map([
  [10, 'Fd10ms'],
  [15, 'Fd15ms'],
  [20, 'Fd20ms'],
  [30, 'Fd30ms'],
  [32, 'Fd32ms'],
]);

class KrispLicenseSDKManager {
  private static module: KrispAudioModule | null = null;
  private static referenceCount = 0;

  static acquire(licenseKey: string): KrispAudioModule {
    if (this.referenceCount === 0) {
      let imported: unknown;
      try {
        imported = require('krisp-audio');
      } catch (error) {
        throw new Error(
          "krisp-audio is not installed. Install Krisp's Node SDK package or use the default LiveKitCloudAuthProvider.",
          { cause: error },
        );
      }

      const module = normalizeModule(imported);
      module.globalInit(
        '',
        licenseKey,
        this.licensingErrorCallback,
        this.logCallback,
        module.LogLevel.Off,
      );
      this.module = module;
      const version = module.getVersion?.();
      if (version) {
        console.debug(
          `Krisp Audio SDK (license) initialized - Version: ${version.major}.${version.minor}.${version.patch}`,
        );
      }
    }
    this.referenceCount += 1;
    return this.module!;
  }

  static release(): void {
    if (this.referenceCount === 0) {
      return;
    }

    this.referenceCount -= 1;
    if (this.referenceCount === 0 && this.module) {
      try {
        this.module.globalDestroy();
      } catch (error) {
        console.error('Error during Krisp SDK cleanup:', error);
      } finally {
        this.module = null;
      }
    }
  }

  static sampleRateEnum(module: KrispAudioModule, sampleRate: number): unknown {
    const key = SAMPLE_RATES.get(sampleRate);
    if (!key || !(key in module.SamplingRate)) {
      throw new Error(
        `Unsupported sample rate: ${sampleRate} Hz. Supported rates: ${[...SAMPLE_RATES.keys()].join(', ')} Hz`,
      );
    }
    return module.SamplingRate[key];
  }

  static frameDurationEnum(module: KrispAudioModule, frameDurationMs: number): unknown {
    const key = FRAME_DURATIONS.get(frameDurationMs);
    if (!key || !(key in module.FrameDuration)) {
      throw new Error(
        `Unsupported frame duration: ${frameDurationMs} ms. Supported durations: ${[
          ...FRAME_DURATIONS.keys(),
        ].join(', ')} ms`,
      );
    }
    return module.FrameDuration[key];
  }

  private static logCallback(message: string, level: unknown): void {
    console.debug(`[Krisp ${String(level)}] ${message}`);
  }

  private static licensingErrorCallback(error: unknown, message: string): void {
    console.error(`[Krisp Licensing Error: ${String(error)}] ${message}`);
  }
}

function normalizeModule(imported: unknown): KrispAudioModule {
  const module = (imported as { default?: unknown }).default ?? imported;
  return module as KrispAudioModule;
}

function concatInt16(arrays: Array<ArrayLike<number>>): Int16Array<ArrayBuffer> {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

/** @internal */
export class KrispLicenseFrameProcessor extends FrameProcessor<AudioFrame> {
  private sdkAcquired = false;
  private filteringEnabled = true;
  private module: KrispAudioModule | null = null;
  private session: KrispSession | null = null;
  private sampleRate: number | null = null;
  private chunkSamples: number | null = null;
  private warnedChannels = false;
  private inBuf: Int16Array<ArrayBuffer> = new Int16Array(0);
  private outBuf: Int16Array<ArrayBuffer> = new Int16Array(0);
  private readonly modelPath: string;
  private readonly frameDurationMs: number;
  private noiseSuppressionLevelValue: number;

  private constructor({
    modelPath,
    noiseSuppressionLevel,
    frameDurationMs,
  }: {
    modelPath: string;
    noiseSuppressionLevel: number;
    frameDurationMs: number;
  }) {
    super();
    this.modelPath = modelPath;
    this.noiseSuppressionLevelValue = noiseSuppressionLevel;
    this.frameDurationMs = frameDurationMs;
  }

  static create({
    licenseKey,
    modelPath,
    noiseSuppressionLevel = 100,
    frameDurationMs = 10,
    sampleRate,
  }: {
    licenseKey: string;
    modelPath: string;
    noiseSuppressionLevel?: number;
    frameDurationMs?: number;
    sampleRate?: number;
  }): KrispLicenseFrameProcessor {
    const processor = new KrispLicenseFrameProcessor({
      modelPath,
      noiseSuppressionLevel,
      frameDurationMs,
    });

    processor.module = KrispLicenseSDKManager.acquire(licenseKey);
    processor.sdkAcquired = true;
    KrispLicenseSDKManager.frameDurationEnum(processor.module, frameDurationMs);
    processor.createSession(sampleRate ?? 16000);
    return processor;
  }

  /** @internal Test-only constructor to bypass SDK loading. */
  static createForTest({
    session,
    sampleRate,
    chunkSamples,
  }: {
    session: KrispSession;
    sampleRate: number;
    chunkSamples: number;
  }): KrispLicenseFrameProcessor {
    const processor = new KrispLicenseFrameProcessor({
      modelPath: '',
      noiseSuppressionLevel: 100,
      frameDurationMs: Math.trunc((chunkSamples * 1000) / sampleRate),
    });
    processor.session = session;
    processor.sampleRate = sampleRate;
    processor.chunkSamples = chunkSamples;
    return processor;
  }

  private createSession(sampleRate: number): void {
    if (this.session && this.sampleRate === sampleRate) {
      return;
    }
    if (!this.module) {
      throw new Error('Krisp SDK is not acquired');
    }

    const modelInfo = new this.module.ModelInfo();
    modelInfo.path = this.modelPath;

    const config = new this.module.NcSessionConfig();
    config.inputSampleRate = KrispLicenseSDKManager.sampleRateEnum(this.module, sampleRate);
    config.inputFrameDuration = KrispLicenseSDKManager.frameDurationEnum(
      this.module,
      this.frameDurationMs,
    );
    config.outputSampleRate = config.inputSampleRate;
    config.modelInfo = modelInfo;

    this.session = this.module.NcInt16.create(config);
    this.sampleRate = sampleRate;
    this.chunkSamples = Math.trunc((sampleRate * this.frameDurationMs) / 1000);
    this.inBuf = new Int16Array(0);
    this.outBuf = new Int16Array(0);
  }

  isEnabled(): boolean {
    return this.filteringEnabled;
  }

  setEnabled(enabled: boolean): void {
    this.filteringEnabled = enabled;
  }

  get noiseSuppressionLevel(): number {
    return this.noiseSuppressionLevelValue;
  }

  set noiseSuppressionLevel(value: number) {
    this.noiseSuppressionLevelValue = Math.trunc(Math.max(0, Math.min(100, value)));
  }

  process(frame: AudioFrame): AudioFrame {
    if (!this.filteringEnabled) {
      return frame;
    }

    if (frame.channels !== 1) {
      if (!this.warnedChannels) {
        console.warn(
          `Krisp filter not applied: expected mono audio but got ${frame.channels} channels; frames are passed through unprocessed.`,
        );
        this.warnedChannels = true;
      }
      return frame;
    }

    if (!this.session || this.sampleRate !== frame.sampleRate) {
      this.createSession(frame.sampleRate);
    }

    if (!this.session || this.chunkSamples === null) {
      throw new Error('Krisp session not initialized');
    }

    const chunk = this.chunkSamples;
    this.inBuf = concatInt16([this.inBuf, frame.data]);

    const numChunks = Math.trunc(this.inBuf.length / chunk);
    if (numChunks > 0) {
      const consumed = numChunks * chunk;
      const pending = new Int16Array(this.inBuf.slice(0, consumed));
      this.inBuf = new Int16Array(this.inBuf.slice(consumed));

      const processed: Array<ArrayLike<number>> = [];
      for (let i = 0; i < numChunks; i += 1) {
        const chunkIn = pending.slice(i * chunk, (i + 1) * chunk);
        let chunkOut: Int16Array<ArrayBufferLike> | ArrayLike<number> | null;
        try {
          chunkOut = this.session.process(chunkIn, this.noiseSuppressionLevelValue);
        } catch (error) {
          console.error('Error processing frame:', error);
          chunkOut = chunkIn;
        }
        if (!chunkOut || chunkOut.length !== chunk) {
          console.warn('Krisp returned unexpected output, using original audio');
          chunkOut = chunkIn;
        }
        processed.push(chunkOut);
      }

      this.outBuf = concatInt16([this.outBuf, ...processed]);
    }

    const samplesToEmit = Math.min(frame.samplesPerChannel, this.outBuf.length);
    const out: Int16Array<ArrayBuffer> = new Int16Array(this.outBuf.slice(0, samplesToEmit));
    this.outBuf = new Int16Array(this.outBuf.slice(samplesToEmit));

    return new AudioFrame(out, frame.sampleRate, frame.channels, out.length, frame.userdata);
  }

  close(): void {
    this.session = null;
    this.inBuf = new Int16Array(0);
    this.outBuf = new Int16Array(0);
  }

  destroy(): void {
    this.close();
    if (this.sdkAcquired) {
      KrispLicenseSDKManager.release();
      this.sdkAcquired = false;
    }
  }
}
