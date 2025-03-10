// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  ExpFilter,
  VADEventType,
  VADStream as baseStream,
  VAD as baseVAD,
  log,
  mergeFrames,
} from '@livekit/agents';
import { AudioFrame, AudioResampler, AudioResamplerQuality } from '@livekit/rtc-node';
import type { InferenceSession } from 'onnxruntime-node';
import type { SampleRate } from './onnx_model.js';
import { OnnxModel, newInferenceSession } from './onnx_model.js';

const SLOW_INFERENCE_THRESHOLD = 200; // late by 200ms

export interface VADOptions {
  /** Minimum duration of speech to start a new speech chunk */
  minSpeechDuration: number;
  /** At the end of each speech, wait this duration before ending the speech */
  minSilenceDuration: number;
  /** Duration of padding to add to the beginning of each speech chunk */
  prefixPaddingDuration: number;
  /** Maximum duration of speech to keep in the buffer */
  maxBufferedSpeech: number;
  /** Maximum duration of speech to keep in the buffer*/
  activationThreshold: number;
  /** Sample rate for the inference (only 8KHz and 16KHz are supported) */
  sampleRate: SampleRate;
  /** Force the use of CPU for inference */
  forceCPU: boolean;
}

const defaultVADOptions: VADOptions = {
  minSpeechDuration: 50,
  minSilenceDuration: 250,
  prefixPaddingDuration: 500,
  maxBufferedSpeech: 60000,
  activationThreshold: 0.5,
  sampleRate: 16000,
  forceCPU: true,
};

export class VAD extends baseVAD {
  #session: InferenceSession;
  #opts: VADOptions;
  #streams: VADStream[];
  label = 'silero.VAD';

  constructor(session: InferenceSession, opts: VADOptions) {
    super({ updateInterval: 32 });
    this.#session = session;
    this.#opts = opts;
    this.#streams = [];
  }

  /**
   * Updates the VAD options with new values.
   *
   * @param opts - Partial options object containing the values to update
   * @remarks
   * This method will merge the provided options with existing options and update all active streams.
   * Only the properties specified in opts will be updated, other properties retain their current values.
   */
  updateOptions(opts: Partial<VADOptions>): void {
    this.#opts = { ...this.#opts, ...opts };
    for (const stream of this.#streams) {
      stream.updateOptions(this.#opts);
    }
  }

  /**
   * Load and initialize the Silero VAD model.
   *
   * This method loads the ONNX model and prepares it for inference. When options are not provided,
   * sane defaults are used.
   *
   * @remarks
   * This method may take time to load the model into memory.
   * It is recommended to call this method inside your prewarm mechanism.
   *
   * @example
   * ```ts
   * export default defineAgent({
   *   prewarm: async (proc: JobProcess) => {
   *     proc.userData.vad = await VAD.load();
   *   },
   *   entry: async (ctx: JobContext) => {
   *     const vad = ctx.proc.userData.vad! as VAD;
   *     // the rest of your agent logic
   *   },
   * });
   * ```
   *
   * @param options -
   * @returns Promise\<{@link VAD}\>: An instance of the VAD class ready for streaming.
   */
  static async load(opts: Partial<VADOptions> = {}): Promise<VAD> {
    const mergedOpts: VADOptions = { ...defaultVADOptions, ...opts };
    const session = await newInferenceSession(mergedOpts.forceCPU);
    return new VAD(session, mergedOpts);
  }

  stream(): VADStream {
    const stream = new VADStream(
      this,
      this.#opts,
      new OnnxModel(this.#session, this.#opts.sampleRate),
    );
    this.#streams.push(stream);
    return stream;
  }
}

export class VADStream extends baseStream {
  #opts: VADOptions;
  #model: OnnxModel;
  #inputSampleRate: number;
  #speechBuffer: Int16Array | null;
  #speechBufferMaxReached: boolean;
  #prefixPaddingSamples: number;
  #task: Promise<void>;
  #expFilter = new ExpFilter(0.35);
  #extraInferenceTime = 0;
  #logger = log();

  constructor(vad: VAD, opts: VADOptions, model: OnnxModel) {
    super(vad);
    this.#opts = opts;
    this.#model = model;
    this.#inputSampleRate = 0;
    this.#speechBuffer = null;
    this.#speechBufferMaxReached = false;
    this.#prefixPaddingSamples = 0;

    this.#task = new Promise(async () => {
      let inferenceData = new Float32Array(this.#model.windowSizeSamples);

      // a copy is exposed to the user in END_OF_SPEECH
      let speechBufferIndex = 0;

      // "pub" means public, these values are exposed to the users through events
      let pubSpeaking = false;
      let pubSpeechDuration = 0;
      let pubSilenceDuration = 0;
      let pubCurrentSample = 0;
      let pubTimestamp = 0;
      let speechThresholdDuration = 0;
      let silenceThresholdDuration = 0;

      let inputFrames = [];
      let inferenceFrames: AudioFrame[] = [];
      let resampler: AudioResampler | null = null;

      // used to avoid drift when the sampleRate ratio is not an integer
      let inputCopyRemainingFrac = 0.0;

      for await (const frame of this.input) {
        if (typeof frame === 'symbol') {
          continue; // ignore flush sentinel for now
        }

        if (!this.#inputSampleRate || !this.#speechBuffer) {
          this.#inputSampleRate = frame.sampleRate;
          this.#prefixPaddingSamples = Math.trunc(
            (this.#opts.prefixPaddingDuration * this.#inputSampleRate) / 1000,
          );
          const bufferSize =
            Math.trunc((this.#opts.maxBufferedSpeech * this.#inputSampleRate) / 1000) +
            this.#prefixPaddingSamples;
          this.#speechBuffer = new Int16Array(bufferSize);

          if (this.#opts.sampleRate !== this.#inputSampleRate) {
            // resampling needed: the input sample rate isn't the same as the model's
            // sample rate used for inference
            resampler = new AudioResampler(
              this.#inputSampleRate,
              this.#opts.sampleRate,
              1,
              AudioResamplerQuality.QUICK, // VAD doesn't need high quality
            );
          }
        } else if (frame.sampleRate !== this.#inputSampleRate) {
          this.#logger.error('a frame with a different sample rate was already published');
          continue;
        }

        inputFrames.push(frame);
        if (resampler) {
          inferenceFrames.push(...resampler.push(frame));
        } else {
          inferenceFrames.push(frame);
        }

        while (true) {
          const startTime = process.hrtime.bigint();
          const availableInferenceSamples = inferenceFrames
            .map((x) => x.samplesPerChannel)
            .reduce((acc, x) => acc + x, 0);

          if (availableInferenceSamples < this.#model.windowSizeSamples) {
            break; // not enough samples to run inference
          }

          const inputFrame = mergeFrames(inputFrames);
          const inferenceFrame = mergeFrames(inferenceFrames);

          // convert data to f32
          inferenceData = Float32Array.from(
            inferenceFrame.data.subarray(0, this.#model.windowSizeSamples),
            (x) => x / 32767,
          );

          const p = await this.#model
            .run(inferenceData)
            .then((data) => this.#expFilter.apply(1, data));

          const windowDuration = (this.#model.windowSizeSamples / this.#opts.sampleRate) * 1000;
          pubCurrentSample += this.#model.windowSizeSamples;
          pubTimestamp += windowDuration;
          const resamplingRatio = this.#inputSampleRate / this.#model.sampleRate;
          const toCopy = this.#model.windowSizeSamples * resamplingRatio + inputCopyRemainingFrac;
          const toCopyInt = Math.trunc(toCopy);
          inputCopyRemainingFrac = toCopy - toCopyInt;

          // copy the inference window to the speech buffer
          const availableSpace = this.#speechBuffer.length - speechBufferIndex;
          const toCopyBuffer = Math.min(this.#model.windowSizeSamples, availableSpace);
          if (toCopyBuffer > 0) {
            this.#speechBuffer.set(inputFrame.data.subarray(0, toCopyBuffer), speechBufferIndex);
            speechBufferIndex += toCopyBuffer;
          } else if (!this.#speechBufferMaxReached) {
            this.#speechBufferMaxReached = true;
            this.#logger.warn(
              'maxBufferedSpeech reached, ignoring further data for the current speech input',
            );
          }

          const inferenceDuration = Number((process.hrtime.bigint() - startTime) / BigInt(1000000));
          this.#extraInferenceTime = Math.max(
            0,
            this.#extraInferenceTime + inferenceDuration - windowDuration,
          );
          if (this.#extraInferenceTime > SLOW_INFERENCE_THRESHOLD) {
            this.#logger
              .child({ delay: this.#extraInferenceTime })
              .warn('inference is slower than realtime');
          }

          if (pubSpeaking) {
            pubSpeechDuration += inferenceDuration;
          } else {
            pubSilenceDuration += inferenceDuration;
          }

          this.queue.put({
            type: VADEventType.INFERENCE_DONE,
            samplesIndex: pubCurrentSample,
            timestamp: pubTimestamp,
            silenceDuration: pubSilenceDuration,
            speechDuration: pubSpeechDuration,
            probability: p,
            inferenceDuration,
            frames: [
              new AudioFrame(
                inputFrame.data.subarray(0, toCopyInt),
                this.#inputSampleRate,
                1,
                toCopyInt,
              ),
            ],
            speaking: pubSpeaking,
            rawAccumulatedSilence: silenceThresholdDuration,
            rawAccumulatedSpeech: speechThresholdDuration,
          });

          const resetWriteCursor = () => {
            if (!this.#speechBuffer) throw new Error('speechBuffer is empty');
            if (speechBufferIndex <= this.#prefixPaddingSamples) {
              return;
            }

            const paddingData = this.#speechBuffer.subarray(
              speechBufferIndex - this.#prefixPaddingSamples,
              speechBufferIndex,
            );
            this.#speechBuffer.set(paddingData, 0);
            speechBufferIndex = this.#prefixPaddingSamples;
            this.#speechBufferMaxReached = false;
          };

          const copySpeechBuffer = (): AudioFrame => {
            if (!this.#speechBuffer) throw new Error('speechBuffer is empty');
            return new AudioFrame(
              this.#speechBuffer.subarray(this.#prefixPaddingSamples, speechBufferIndex),
              this.#inputSampleRate,
              1,
              speechBufferIndex,
            );
          };

          if (p > this.#opts.activationThreshold) {
            speechThresholdDuration += windowDuration;
            silenceThresholdDuration = 0;
            if (!pubSpeaking && speechThresholdDuration >= this.#opts.minSpeechDuration) {
              pubSpeaking = true;
              pubSilenceDuration = 0;
              pubSpeechDuration = speechThresholdDuration;

              this.queue.put({
                type: VADEventType.START_OF_SPEECH,
                samplesIndex: pubCurrentSample,
                timestamp: pubTimestamp,
                silenceDuration: pubSilenceDuration,
                speechDuration: pubSpeechDuration,
                probability: p,
                inferenceDuration,
                frames: [copySpeechBuffer()],
                speaking: pubSpeaking,
                rawAccumulatedSilence: 0,
                rawAccumulatedSpeech: 0,
              });
            }
          } else {
            silenceThresholdDuration += windowDuration;
            speechThresholdDuration = 0;

            if (!pubSpeaking) {
              resetWriteCursor();
            }

            if (pubSpeaking && silenceThresholdDuration > this.#opts.minSilenceDuration) {
              pubSpeaking = false;
              pubSpeechDuration = 0;
              pubSilenceDuration = silenceThresholdDuration;

              this.queue.put({
                type: VADEventType.END_OF_SPEECH,
                samplesIndex: pubCurrentSample,
                timestamp: pubTimestamp,
                silenceDuration: pubSilenceDuration,
                speechDuration: pubSpeechDuration,
                probability: p,
                inferenceDuration,
                frames: [copySpeechBuffer()],
                speaking: pubSpeaking,
                rawAccumulatedSilence: 0,
                rawAccumulatedSpeech: 0,
              });

              resetWriteCursor();
            }
          }

          inputFrames = [];
          inferenceFrames = [];

          if (inputFrame.data.length > toCopyInt) {
            const data = inputFrame.data.subarray(toCopyInt);
            inputFrames.push(
              new AudioFrame(data, this.#inputSampleRate, 1, Math.trunc(data.length / 2)),
            );
          }
          if (inferenceFrame.data.length > this.#model.windowSizeSamples) {
            const data = inferenceFrame.data.subarray(this.#model.windowSizeSamples);
            inferenceFrames.push(
              new AudioFrame(data, this.#opts.sampleRate, 1, Math.trunc(data.length / 2)),
            );
          }
        }
      }
    });
  }

  /**
   * Update the VAD options
   *
   * @param opts - Partial options object containing the values to update
   * @remarks
   * This method allows you to update the VAD options after the VAD object has been created
   */
  updateOptions(opts: Partial<VADOptions>) {
    const oldMaxBufferedSpeech = this.#opts.maxBufferedSpeech;
    this.#opts = { ...this.#opts, ...opts };

    if (this.#inputSampleRate) {
      // Assert speech buffer exists
      if (this.#speechBuffer === null) throw new Error('speechBuffer is null');

      // Resize speech buffer
      this.#prefixPaddingSamples = Math.trunc(
        (this.#opts.prefixPaddingDuration * this.#inputSampleRate) / 1000,
      );
      const bufferSize =
        Math.trunc((this.#opts.maxBufferedSpeech * this.#inputSampleRate) / 1000) +
        this.#prefixPaddingSamples;
      const resizedBuffer = new Int16Array(bufferSize);
      resizedBuffer.set(
        this.#speechBuffer.subarray(0, Math.min(this.#speechBuffer.length, bufferSize)),
      );
      this.#speechBuffer = resizedBuffer;

      // Determine if max has been reached
      if (this.#opts.maxBufferedSpeech > oldMaxBufferedSpeech) {
        this.#speechBufferMaxReached = false;
      }
    }
  }
}
