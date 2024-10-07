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
  prefixPaddingDuration: 100,
  maxBufferedSpeech: 60000,
  activationThreshold: 0.5,
  sampleRate: 16000,
  forceCPU: true,
};

export class VAD extends baseVAD {
  #session: InferenceSession;
  #opts: VADOptions;

  constructor(session: InferenceSession, opts: VADOptions) {
    super({ updateInterval: 32 });
    this.#session = session;
    this.#opts = opts;
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
  static async load(opts = defaultVADOptions): Promise<VAD> {
    const session = await newInferenceSession(opts.forceCPU);
    return new VAD(session, opts);
  }

  stream(): VADStream {
    return new VADStream(this.#opts, new OnnxModel(this.#session, this.#opts.sampleRate));
  }
}

export class VADStream extends baseStream {
  #opts: VADOptions;
  #model: OnnxModel;
  #task: Promise<void>;
  #expFilter = new ExpFilter(0.35);
  #extraInferenceTime = 0;
  #logger = log();

  constructor(opts: VADOptions, model: OnnxModel) {
    super();
    this.#opts = opts;
    this.#model = model;

    this.#task = new Promise(async () => {
      let inferenceData = new Float32Array(this.#model.windowSizeSamples);

      // a copy is exposed to the user in END_OF_SPEECH
      let speechBuffer: Int16Array | null = null;
      let speechBufferMaxReached = false;
      let speechBufferIndex = 0;

      // "pub" means public, these values are exposed to the users through events
      let pubSpeaking = false;
      let pubSpeechDuration = 0;
      let pubSilenceDuration = 0;
      let pubCurrentSample = 0;
      let pubTimestamp = 0;
      let pubSampleRate = 0;
      let pubPrefixPaddingSamples = 0; // size in samples of padding data

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

        if (!pubSampleRate || !speechBuffer) {
          pubSampleRate = frame.sampleRate;
          pubPrefixPaddingSamples = Math.ceil(this.#opts.prefixPaddingDuration * pubSampleRate);

          speechBuffer = new Int16Array(
            (this.#opts.maxBufferedSpeech + this.#opts.prefixPaddingDuration) * pubCurrentSample,
          );

          if (this.#opts.sampleRate !== pubSampleRate) {
            // resampling needed: the input sample rate isn't the same as the model's
            // sample rate used for inference
            resampler = new AudioResampler(
              pubSampleRate,
              this.#opts.sampleRate,
              1,
              AudioResamplerQuality.QUICK, // VAD doesn't need high quality
            );
          }
        } else if (frame.sampleRate !== pubSampleRate) {
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
          const resamplingRatio = pubSampleRate / this.#model.sampleRate;
          const toCopy = this.#model.windowSizeSamples * resamplingRatio + inputCopyRemainingFrac;
          const toCopyInt = Math.trunc(toCopy);
          inputCopyRemainingFrac = toCopy - toCopyInt;

          // copy the inference window to the speech buffer
          const availableSpace = speechBuffer.length - speechBufferIndex;
          const toCopyBuffer = Math.min(this.#model.windowSizeSamples, availableSpace);
          if (toCopyBuffer > 0) {
            speechBuffer.set(inputFrame.data.subarray(0, toCopyBuffer), speechBufferIndex);
          } else if (!speechBufferMaxReached) {
            speechBufferMaxReached = true;
            this.#logger.warn(
              'max_buffered_speech reached, ignoring further data for the current speech input',
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
                new Int16Array(inputFrame.data.subarray(0, toCopyInt)),
                pubSampleRate,
                1,
                toCopyInt,
              ),
            ],
            speaking: pubSpeaking,
          });

          const copySpeechBuffer = (): AudioFrame => {
            if (!speechBuffer) throw new Error('speechBuffer is empty');
            return new AudioFrame(
              new Int16Array(speechBuffer.subarray(0, speechBufferIndex)),
              pubSampleRate,
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
              });
            }
          } else {
            silenceThresholdDuration += windowDuration;
            speechThresholdDuration = 0;

            if (!pubSpeaking && speechBufferIndex <= pubPrefixPaddingSamples) {
              const paddingData = speechBuffer.subarray(
                speechBufferIndex - pubPrefixPaddingSamples,
                speechBufferIndex,
              );
              speechBuffer.set(paddingData, 0);
              speechBufferIndex = pubPrefixPaddingSamples;
              speechBufferMaxReached = false;
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
              });
            }
          }

          inputFrames = [];
          inferenceFrames = [];

          if (inputFrame.data.length > toCopyInt) {
            const data = new Int16Array(inputFrame.data.subarray(toCopyInt));
            inputFrames.push(new AudioFrame(data, pubSampleRate, 1, Math.trunc(data.length / 2)));
          }
          if (inferenceFrame.data.length > this.#model.windowSizeSamples) {
            const data = new Int16Array(
              inferenceFrame.data.subarray(this.#model.windowSizeSamples),
            );
            inferenceFrames.push(
              new AudioFrame(data, this.#opts.sampleRate, 1, Math.trunc(data.length / 2)),
            );
          }
        }
      }
    });
  }
}
