// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Voice Activity Detection backed by `@livekit/local-inference`.
 *
 * Provides the same streaming VAD shape as `plugins/silero` but routes
 * inference through the bundled native model so a default instance can be
 * auto-provisioned by `AgentSession` without an explicit plugin import.
 *
 * Port of Python `livekit.agents.inference.vad`.
 */
import { AudioFrame, AudioResampler, AudioResamplerQuality } from '@livekit/rtc-node';
import { log } from '../log.js';
import { VAD as BaseVAD, VADStream as BaseVADStream, VADEventType } from '../vad.js';
import { _getLocalInferenceModule } from './_warmup.js';

const SLOW_INFERENCE_THRESHOLD_MS = 200;
const MODEL_SAMPLE_RATE = 16000;

export type VADModels = 'silero';

export interface VADOptions {
  /** Minimum speech duration (ms) before reporting START_OF_SPEECH. */
  minSpeechDuration: number;
  /** Trailing silence (ms) before reporting END_OF_SPEECH. */
  minSilenceDuration: number;
  /** Pre-roll (ms) included in the speech buffer ahead of START_OF_SPEECH. */
  prefixPaddingDuration: number;
  /** Maximum (ms) of buffered speech per utterance. */
  maxBufferedSpeech: number;
  /** Sigmoid probability threshold for activation. */
  activationThreshold: number;
  /** Sigmoid probability threshold for deactivation (defaults to
   * `max(activationThreshold - 0.15, 0.01)`). */
  deactivationThreshold: number;
}

const defaultVADOptions: VADOptions = {
  minSpeechDuration: 50,
  // 250ms (= MIN_SILENCE_DURATION_MS + 50) so the default satisfies the audio
  // end-of-turn detector's silence-window requirement out of the box.
  minSilenceDuration: 250,
  prefixPaddingDuration: 500,
  maxBufferedSpeech: 60_000,
  activationThreshold: 0.5,
  deactivationThreshold: 0.35,
};

export class VAD extends BaseVAD {
  protected _opts: VADOptions;
  protected _model: VADModels;
  label = 'inference.VAD';
  // Live streams, tracked weakly so they don't outlive their consumers. JS
  // `WeakSet` isn't iterable, so we hold `WeakRef`s in a `Set` and prune dead
  // entries on iteration — the iterable equivalent of Python's `weakref.WeakSet`.
  #streams = new Set<WeakRef<InferenceVADStream>>();

  constructor(opts: Partial<VADOptions> & { model?: VADModels } = {}) {
    super({ updateInterval: 32 });
    const model: VADModels = opts.model ?? 'silero';
    if (model !== 'silero') {
      throw new Error(`Unknown VAD model: ${String(model)}. Supported: 'silero'.`);
    }
    if (opts.deactivationThreshold !== undefined && opts.deactivationThreshold <= 0) {
      throw new Error('deactivationThreshold must be greater than 0');
    }
    this._model = model;
    const activation = opts.activationThreshold ?? defaultVADOptions.activationThreshold;
    this._opts = {
      ...defaultVADOptions,
      ...opts,
      activationThreshold: activation,
      deactivationThreshold: opts.deactivationThreshold ?? Math.max(activation - 0.15, 0.01),
    };
  }

  get model(): string {
    return this._model;
  }

  get provider(): string {
    return 'livekit-local-inference';
  }

  override get minSilenceDuration(): number {
    return this._opts.minSilenceDuration;
  }

  /** Update one or more knobs at runtime, propagating to live streams. */
  updateOptions(opts: Partial<VADOptions>): void {
    this._opts = { ...this._opts, ...opts };
    for (const ref of this.#streams) {
      const stream = ref.deref();
      if (stream === undefined) {
        this.#streams.delete(ref);
        continue;
      }
      stream.updateOptions(opts);
    }
  }

  stream(): BaseVADStream {
    // Each stream owns its own options snapshot so its `updateOptions` can read
    // the prior `maxBufferedSpeech` before this VAD's copy is mutated.
    const stream = new InferenceVADStream(this, { ...this._opts });
    this.#streams.add(new WeakRef(stream));
    return stream;
  }
}

class InferenceVADStream extends BaseVADStream {
  private _opts: VADOptions;
  private _logger = log();
  private _nativeVad:
    | ReturnType<NonNullable<ReturnType<typeof _getLocalInferenceModule>>['createVad']>
    | undefined;
  private _windowSamples: number;
  private _inputSampleRate = 0;
  private _resampler: AudioResampler | undefined;
  private _speechBuffer: Int16Array | null = null;
  private _speechBufferMaxReached = false;
  private _prefixPaddingSamples = 0;
  private _pumpTask: Promise<void>;

  constructor(parent: VAD, opts: VADOptions) {
    super(parent);
    this._opts = opts;
    const mod = _getLocalInferenceModule();
    if (mod === undefined) {
      this._logger.warn(
        'inference.VAD created without @livekit/local-inference; stream will be a no-op',
      );
      this._windowSamples = 512;
    } else {
      this._nativeVad = mod.createVad();
      this._windowSamples = mod.VAD_WINDOW_SAMPLES;
    }
    this._pumpTask = this._pump().catch((err) => {
      this._logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'VAD pump failed',
      );
    });
  }

  /**
   * Apply updated options to this live stream. Once the input sample rate is
   * known, recomputes the prefix-padding pre-roll and resizes the speech
   * buffer in place, preserving any audio already accumulated.
   */
  updateOptions(opts: Partial<VADOptions>): void {
    const oldMaxBufferedSpeech = this._opts.maxBufferedSpeech;
    this._opts = { ...this._opts, ...opts };

    if (this._inputSampleRate && this._speechBuffer !== null) {
      this._prefixPaddingSamples = Math.trunc(
        (this._opts.prefixPaddingDuration * this._inputSampleRate) / 1000,
      );
      const bufferSize =
        Math.trunc((this._opts.maxBufferedSpeech * this._inputSampleRate) / 1000) +
        this._prefixPaddingSamples;
      const resized = new Int16Array(bufferSize);
      resized.set(this._speechBuffer.subarray(0, Math.min(this._speechBuffer.length, bufferSize)));
      this._speechBuffer = resized;

      if (this._opts.maxBufferedSpeech > oldMaxBufferedSpeech) {
        this._speechBufferMaxReached = false;
      }
    }
  }

  private async _pump(): Promise<void> {
    let pubSpeaking = false;
    let pubSpeechDurationMs = 0;
    let pubSilenceDurationMs = 0;
    let pubCurrentSample = 0;
    let pubTimestampMs = 0;
    let speechThresholdDurationMs = 0;
    let silenceThresholdDurationMs = 0;
    let inputFrames: AudioFrame[] = [];
    let inferenceFrames: AudioFrame[] = [];
    let inputCopyRemainingFrac = 0;
    let extraInferenceTime = 0;
    // Write cursor into `_speechBuffer`. The buffer holds:
    //   [ ...prefix-padding (sliding pre-roll) ..., ...active speech... ]
    // and is reset on END_OF_SPEECH (and on silence while idle) so the next
    // turn starts from a fresh pre-roll window.
    let speechBufferIndex = 0;

    const resetWriteCursor = () => {
      if (this._speechBuffer === null) return;
      if (speechBufferIndex <= this._prefixPaddingSamples) return;
      // Slide the most-recent `prefixPaddingSamples` samples to the head
      // of the buffer so the next utterance has continuous pre-roll
      // context (the audio that immediately preceded START_OF_SPEECH).
      const paddingData = this._speechBuffer.subarray(
        speechBufferIndex - this._prefixPaddingSamples,
        speechBufferIndex,
      );
      this._speechBuffer.set(paddingData, 0);
      speechBufferIndex = this._prefixPaddingSamples;
      this._speechBufferMaxReached = false;
    };

    const resetState = () => {
      this._nativeVad?.reset();

      speechBufferIndex = 0;
      this._speechBufferMaxReached = false;
      this._speechBuffer?.fill(0);

      pubSpeaking = false;
      pubSpeechDurationMs = 0;
      pubSilenceDurationMs = 0;
      pubCurrentSample = 0;
      pubTimestampMs = 0;
      speechThresholdDurationMs = 0;
      silenceThresholdDurationMs = 0;

      inputFrames = [];
      inferenceFrames = [];
      inputCopyRemainingFrac = 0;
      extraInferenceTime = 0;

      this._resampler?.close?.();
      if (this._inputSampleRate && this._inputSampleRate !== MODEL_SAMPLE_RATE) {
        this._resampler = new AudioResampler(
          this._inputSampleRate,
          MODEL_SAMPLE_RATE,
          1,
          AudioResamplerQuality.QUICK,
        );
      } else {
        this._resampler = undefined;
      }
    };

    const copySpeechBuffer = (): AudioFrame => {
      if (this._speechBuffer === null) {
        return new AudioFrame(new Int16Array(0), this._inputSampleRate, 1, 0);
      }
      return new AudioFrame(
        this._speechBuffer.subarray(0, speechBufferIndex),
        this._inputSampleRate,
        1,
        speechBufferIndex,
      );
    };

    while (!this.closed) {
      const { done, value: frame } = await this.inputReader.read();
      if (done) break;
      if (typeof frame === 'symbol') {
        resetState();
        continue;
      }

      if (!this._inputSampleRate) {
        this._inputSampleRate = frame.sampleRate;
        this._prefixPaddingSamples = Math.trunc(
          (this._opts.prefixPaddingDuration * this._inputSampleRate) / 1000,
        );
        const bufferSize =
          Math.trunc((this._opts.maxBufferedSpeech * this._inputSampleRate) / 1000) +
          this._prefixPaddingSamples;
        this._speechBuffer = new Int16Array(bufferSize);
        if (this._inputSampleRate !== MODEL_SAMPLE_RATE) {
          this._resampler = new AudioResampler(
            this._inputSampleRate,
            MODEL_SAMPLE_RATE,
            1,
            AudioResamplerQuality.QUICK,
          );
        }
      } else if (frame.sampleRate !== this._inputSampleRate) {
        this._logger.error('a frame with a different sample rate was already pushed');
        continue;
      }

      if (this._speechBuffer === null) continue;

      inputFrames.push(frame);
      if (this._resampler !== undefined) {
        inferenceFrames.push(...this._resampler.push(frame));
      } else {
        inferenceFrames.push(frame);
      }

      while (!this.closed) {
        const startTime = performance.now();
        const availableInferenceSamples = inferenceFrames.reduce(
          (acc, f) => acc + f.samplesPerChannel,
          0,
        );
        if (availableInferenceSamples < this._windowSamples) break;

        const inputFrame = mergeFrames(inputFrames);
        const inferenceFrame = mergeFrames(inferenceFrames);
        const inferenceWindow = inferenceFrame.data.subarray(0, this._windowSamples);

        let p = 0.0;
        if (this._nativeVad !== undefined) {
          p = await this._nativeVad.predict(inferenceWindow);
        }

        const windowDurationMs = (this._windowSamples / MODEL_SAMPLE_RATE) * 1000;
        pubCurrentSample += this._windowSamples;
        pubTimestampMs += windowDurationMs;
        const resamplingRatio = this._inputSampleRate / MODEL_SAMPLE_RATE;
        const toCopy = this._windowSamples * resamplingRatio + inputCopyRemainingFrac;
        const toCopyInt = Math.trunc(toCopy);
        inputCopyRemainingFrac = toCopy - toCopyInt;

        // Append the input-rate samples we just consumed into the
        // speech buffer so START_OF_SPEECH / END_OF_SPEECH events can
        // hand downstream consumers (STT, transcription) the prefix-
        // padded audio they need.
        const availableSpace = this._speechBuffer.length - speechBufferIndex;
        const toCopyBuffer = Math.min(toCopyInt, availableSpace);
        if (toCopyBuffer > 0) {
          this._speechBuffer.set(inputFrame.data.subarray(0, toCopyBuffer), speechBufferIndex);
          speechBufferIndex += toCopyBuffer;
        } else if (!this._speechBufferMaxReached) {
          this._speechBufferMaxReached = true;
          this._logger.warn(
            'maxBufferedSpeech reached, ignoring further data for the current speech input',
          );
        }

        const inferenceDuration = performance.now() - startTime;
        extraInferenceTime = Math.max(0, extraInferenceTime + inferenceDuration - windowDurationMs);
        // Guard on the per-window inference duration (not the accumulated slack)
        // to match Python; the accumulated value is still surfaced as the delay.
        if (inferenceDuration > SLOW_INFERENCE_THRESHOLD_MS) {
          this._logger.warn(
            { extraInferenceTimeMs: extraInferenceTime },
            'VAD slower than realtime',
          );
        }

        if (pubSpeaking) pubSpeechDurationMs += windowDurationMs;
        else pubSilenceDurationMs += windowDurationMs;

        this.sendVADEvent({
          type: VADEventType.INFERENCE_DONE,
          samplesIndex: pubCurrentSample,
          timestamp: pubTimestampMs,
          silenceDuration: pubSilenceDurationMs,
          speechDuration: pubSpeechDurationMs,
          probability: p,
          inferenceDuration,
          frames: [
            new AudioFrame(
              inputFrame.data.subarray(0, toCopyInt),
              this._inputSampleRate,
              1,
              toCopyInt,
            ),
          ],
          speaking: pubSpeaking,
          rawAccumulatedSilence: silenceThresholdDurationMs,
          rawAccumulatedSpeech: speechThresholdDurationMs,
        });

        if (
          p >= this._opts.activationThreshold ||
          (pubSpeaking && p > this._opts.deactivationThreshold)
        ) {
          speechThresholdDurationMs += windowDurationMs;
          silenceThresholdDurationMs = 0;
          if (!pubSpeaking && speechThresholdDurationMs >= this._opts.minSpeechDuration) {
            pubSpeaking = true;
            pubSilenceDurationMs = 0;
            pubSpeechDurationMs = speechThresholdDurationMs;
            this.sendVADEvent({
              type: VADEventType.START_OF_SPEECH,
              samplesIndex: pubCurrentSample,
              timestamp: pubTimestampMs,
              silenceDuration: pubSilenceDurationMs,
              speechDuration: pubSpeechDurationMs,
              probability: p,
              inferenceDuration,
              frames: [copySpeechBuffer()],
              speaking: true,
              rawAccumulatedSilence: 0,
              rawAccumulatedSpeech: 0,
            });
          }
        } else {
          silenceThresholdDurationMs += windowDurationMs;
          speechThresholdDurationMs = 0;
          // Keep a sliding pre-roll window while we're not in active
          // speech — without this the buffer would fill with idle
          // silence and the next START_OF_SPEECH would lose its
          // prefix-padding context.
          if (!pubSpeaking) resetWriteCursor();
          if (pubSpeaking && silenceThresholdDurationMs >= this._opts.minSilenceDuration) {
            pubSpeaking = false;
            pubSilenceDurationMs = silenceThresholdDurationMs;
            this.sendVADEvent({
              type: VADEventType.END_OF_SPEECH,
              samplesIndex: pubCurrentSample,
              timestamp: pubTimestampMs,
              silenceDuration: pubSilenceDurationMs,
              speechDuration: Math.max(0, pubSpeechDurationMs - silenceThresholdDurationMs),
              probability: p,
              inferenceDuration,
              frames: [copySpeechBuffer()],
              speaking: false,
              rawAccumulatedSilence: 0,
              rawAccumulatedSpeech: 0,
            });
            pubSpeechDurationMs = 0;
            resetWriteCursor();
          }
        }

        inputFrames = [];
        inferenceFrames = [];
        if (inputFrame.data.length > toCopyInt) {
          const data = inputFrame.data.subarray(toCopyInt);
          inputFrames.push(new AudioFrame(data, this._inputSampleRate, 1, Math.trunc(data.length)));
        }
        if (inferenceFrame.data.length > this._windowSamples) {
          const data = inferenceFrame.data.subarray(this._windowSamples);
          inferenceFrames.push(new AudioFrame(data, MODEL_SAMPLE_RATE, 1, Math.trunc(data.length)));
        }
      }
    }
    this._resampler?.close?.();
  }
}

/** Minimal frame-merging helper. The silero plugin uses `mergeFrames` from
 * the agents package — for the inference VAD we keep a local copy to avoid
 * an import cycle through `index.ts`. */
function mergeFrames(frames: AudioFrame[]): AudioFrame {
  if (frames.length === 1) return frames[0]!;
  const sampleRate = frames[0]!.sampleRate;
  const channels = frames[0]!.channels;
  let total = 0;
  for (const f of frames) total += f.samplesPerChannel;
  const buf = new Int16Array(total * channels);
  let offset = 0;
  for (const f of frames) {
    buf.set(f.data, offset);
    offset += f.samplesPerChannel * channels;
  }
  return new AudioFrame(buf, sampleRate, channels, total);
}
