import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type { Span } from '@opentelemetry/api';
import { type ReadableStream, TransformStream } from 'stream/web';
import { log } from '../../log.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { traceTypes } from '../../telemetry/index.js';
import { createAccessToken } from '../utils.js';
import type {
  AdaptiveInterruptionDetector,
  InterruptionOptions,
} from './AdaptiveInterruptionDetector.js';
import { apiConnectDefaults } from './defaults.js';
import { predictHTTP } from './http_transport.js';
import {
  InterruptionCacheEntry,
  type InterruptionDetectionError,
  type InterruptionEvent,
  InterruptionEventType,
} from './interruption.js';

export interface AgentSpeechStarted {
  type: 'agent-speech-started';
}

export interface AgentSpeechEnded {
  type: 'agent-speech-ended';
}

export interface OverlapSpeechStarted {
  type: 'overlap-speech-started';
  speechDuration: number;
  userSpeakingSpan: Span;
}

export interface OverlapSpeechEnded {
  type: 'overlap-speech-ended';
}

export interface Flush {
  type: 'flush';
}

export type InterruptionSentinel =
  | AgentSpeechStarted
  | AgentSpeechEnded
  | OverlapSpeechStarted
  | OverlapSpeechEnded
  | Flush;

export class InterruptionStreamSentinel {
  static speechStarted(): AgentSpeechStarted {
    return { type: 'agent-speech-started' };
  }

  static speechEnded(): AgentSpeechEnded {
    return { type: 'agent-speech-ended' };
  }

  static overlapSpeechStarted(
    speechDuration: number,
    userSpeakingSpan: Span,
  ): OverlapSpeechStarted {
    return { type: 'overlap-speech-started', speechDuration, userSpeakingSpan };
  }

  static overlapSpeechEnded(): OverlapSpeechEnded {
    return { type: 'overlap-speech-ended' };
  }

  static flush(): Flush {
    return { type: 'flush' };
  }
}

export interface ApiConnectOptions {
  maxRetries: number;
  retryInterval: number;
  timeout: number;
}

function updateUserSpeakingSpan(span: Span, entry: InterruptionCacheEntry) {
  span.setAttribute(
    traceTypes.ATTR_IS_INTERRUPTION,
    (entry.isInterruption ?? false).toString().toLowerCase(),
  );
  span.setAttribute(traceTypes.ATTR_INTERRUPTION_PROBABILITY, entry.probability);
  span.setAttribute(traceTypes.ATTR_INTERRUPTION_TOTAL_DURATION, entry.totalDuration);
  span.setAttribute(traceTypes.ATTR_INTERRUPTION_PREDICTION_DURATION, entry.predictionDuration);
  span.setAttribute(traceTypes.ATTR_INTERRUPTION_DETECTION_DELAY, entry.detectionDelay);
}

export class InterruptionStreamBase {
  private inputStream: StreamChannel<InterruptionSentinel | AudioFrame, InterruptionDetectionError>;

  private eventStream: ReadableStream<InterruptionEvent>;

  private resampler?: AudioResampler;

  private userSpeakingSpan: Span | undefined;

  private overlapSpeechStartedAt: number | undefined;

  private options: InterruptionOptions;

  private apiOptions: ApiConnectOptions;

  private model: AdaptiveInterruptionDetector;

  private logger = log();

  constructor(model: AdaptiveInterruptionDetector, apiOptions: Partial<ApiConnectOptions>) {
    this.inputStream = createStreamChannel<
      InterruptionSentinel | AudioFrame,
      InterruptionDetectionError
    >();

    this.model = model;
    this.options = model.options;
    this.apiOptions = { ...apiConnectDefaults, ...apiOptions };

    this.eventStream = this.setupTransform();
  }

  private setupTransform(): ReadableStream<InterruptionEvent> {
    let agentSpeechStarted = false;
    let startIdx = 0;
    let accumulatedSamples = 0;
    let overlapSpeechStarted = false;
    const cache = new Map<number, InterruptionCacheEntry>(); // TODO limit cache size
    const inferenceS16Data = new Int16Array(
      Math.ceil(this.options.maxAudioDuration * this.options.sampleRate),
    ).fill(0);

    // First transform: process input frames/sentinels and output audio slices or events
    const audioTransformer = new TransformStream<
      InterruptionSentinel | AudioFrame,
      Int16Array | InterruptionEvent
    >(
      {
        transform: (chunk, controller) => {
          if (chunk instanceof AudioFrame) {
            if (!agentSpeechStarted) {
              return;
            }
            if (this.options.sampleRate !== chunk.sampleRate) {
              controller.error('the sample rate of the input frames must be consistent');
              return;
            }
            const result = writeToInferenceS16Data(
              chunk,
              startIdx,
              inferenceS16Data,
              this.options.maxAudioDuration,
            );
            startIdx = result.startIdx;
            accumulatedSamples += result.samplesWritten;

            // Send data for inference when enough samples accumulated during overlap
            if (
              accumulatedSamples >=
                Math.floor(this.options.detectionInterval * this.options.sampleRate) &&
              overlapSpeechStarted
            ) {
              // Send a copy of the audio data up to startIdx for inference
              const audioSlice = inferenceS16Data.slice(0, startIdx);
              accumulatedSamples = 0;
              controller.enqueue(audioSlice);
            }
          } else if (chunk.type === 'agent-speech-started') {
            this.logger.debug('agent speech started');
            agentSpeechStarted = true;
            overlapSpeechStarted = false;
            accumulatedSamples = 0;
            startIdx = 0;
            cache.clear();
          } else if (chunk.type === 'agent-speech-ended') {
            this.logger.debug('agent speech ended');
            agentSpeechStarted = false;
            overlapSpeechStarted = false;
            accumulatedSamples = 0;
            startIdx = 0;
            cache.clear();
          } else if (chunk.type === 'overlap-speech-started' && agentSpeechStarted) {
            this.userSpeakingSpan = chunk.userSpeakingSpan;
            this.logger.debug('overlap speech started, starting interruption inference');
            overlapSpeechStarted = true;
            accumulatedSamples = 0;
            // Include both speech duration and audio prefix duration for context
            const shiftSize = Math.min(
              startIdx,
              Math.round(chunk.speechDuration * this.options.sampleRate) +
                Math.round(this.options.audioPrefixDuration * this.options.sampleRate),
            );
            // Shift the buffer: copy the last `shiftSize` samples before startIdx
            // to the beginning of the buffer. This preserves recent audio context
            // (the user's speech that occurred just before overlap was detected).
            inferenceS16Data.copyWithin(0, startIdx - shiftSize, startIdx);
            startIdx = shiftSize;
            cache.clear();
          } else if (chunk.type === 'overlap-speech-ended') {
            this.logger.debug('overlap speech ended');
            if (overlapSpeechStarted) {
              this.userSpeakingSpan = undefined;
              let latestEntry = Array.from(cache.values()).at(-1);
              if (!latestEntry) {
                this.logger.debug('no request made for overlap speech');
                latestEntry = InterruptionCacheEntry.default();
              } else {
                cache.delete(latestEntry.createdAt);
              }
              const event: InterruptionEvent = {
                type: InterruptionEventType.OVERLAP_SPEECH_ENDED,
                timestamp: Date.now(),
                isInterruption: false,
                overlapSpeechStartedAt: this.overlapSpeechStartedAt,
                speechInput: latestEntry.speechInput,
                probabilities: latestEntry.probabilities,
                totalDuration: latestEntry.totalDuration,
                detectionDelay: latestEntry.detectionDelay,
                predictionDuration: latestEntry.predictionDuration,
                probability: latestEntry.probability,
              };
              controller.enqueue(event);
              overlapSpeechStarted = false;
            }
          } else if (chunk.type === 'flush') {
            // no-op
          }
        },
      },
      { highWaterMark: 32 },
      { highWaterMark: 32 },
    );

    // Second transform: HTTP transport - converts audio slices to events, passes through existing events
    const httpTransport = new TransformStream<Int16Array | InterruptionEvent, InterruptionEvent>(
      {
        transform: async (chunk, controller) => {
          // Pass through InterruptionEvents unchanged
          if (!(chunk instanceof Int16Array)) {
            controller.enqueue(chunk);
            return;
          }

          if (!this.overlapSpeechStartedAt) {
            return;
          }
          const resp = await predictHTTP(
            chunk,
            { threshold: this.options.threshold, minFrames: this.options.minFrames },
            {
              baseUrl: this.options.baseUrl,
              timeout: this.options.inferenceTimeout,
              token: await createAccessToken(this.options.apiKey, this.options.apiSecret),
            },
          );
          const { createdAt, isBargein, probabilities, predictionDuration } = resp;
          const entry = new InterruptionCacheEntry({
            createdAt,
            probabilities,
            isInterruption: isBargein,
            speechInput: chunk,
            totalDuration: (performance.now() - createdAt) / 1000,
            detectionDelay: Date.now() - this.overlapSpeechStartedAt,
            predictionDuration,
          });
          cache.set(createdAt, entry);
          if (overlapSpeechStarted && entry.isInterruption) {
            if (this.userSpeakingSpan) {
              updateUserSpeakingSpan(this.userSpeakingSpan, entry);
            }
            const event: InterruptionEvent = {
              type: InterruptionEventType.INTERRUPTION,
              timestamp: Date.now(),
              overlapSpeechStartedAt: this.overlapSpeechStartedAt,
              isInterruption: entry.isInterruption,
              speechInput: entry.speechInput,
              probabilities: entry.probabilities,
              totalDuration: entry.totalDuration,
              predictionDuration: entry.predictionDuration,
              detectionDelay: entry.detectionDelay,
              probability: entry.probability,
            };
            this.logger.debug(
              { detectionDelay: entry.detectionDelay, totalDuration: entry.totalDuration },
              'interruption detected',
            );
            overlapSpeechStarted = false;
            controller.enqueue(event);
          }
        },
      },
      { highWaterMark: 2 },
      { highWaterMark: 2 },
    );

    // Pipeline: input -> audioTransformer -> httpTransport -> eventStream
    return this.inputStream.stream().pipeThrough(audioTransformer).pipeThrough(httpTransport);
  }

  private ensureInputNotEnded() {
    if (this.inputStream.closed) {
      throw new Error('input stream is closed');
    }
  }

  private ensureStreamsNotEnded() {
    this.ensureInputNotEnded();
  }

  private getResamplerFor(inputSampleRate: number): AudioResampler {
    if (!this.resampler) {
      this.resampler = new AudioResampler(inputSampleRate, this.options.sampleRate);
    }
    return this.resampler;
  }

  stream(): ReadableStream<InterruptionEvent> {
    return this.eventStream;
  }

  async pushFrame(frame: InterruptionSentinel | AudioFrame): Promise<void> {
    this.ensureStreamsNotEnded();
    if (!(frame instanceof AudioFrame)) {
      if (frame.type === 'overlap-speech-started') {
        this.overlapSpeechStartedAt = Date.now() - frame.speechDuration;
      }
      return this.inputStream.write(frame);
    } else if (this.options.sampleRate !== frame.sampleRate) {
      const resampler = this.getResamplerFor(frame.sampleRate);
      if (resampler.inputRate !== frame.sampleRate) {
        throw new Error('the sample rate of the input frames must be consistent');
      }
      for (const resampledFrame of resampler.push(frame)) {
        await this.inputStream.write(resampledFrame);
      }
    } else {
      await this.inputStream.write(frame);
    }
  }

  async flush(): Promise<void> {
    this.ensureStreamsNotEnded();
    this.inputStream.write(InterruptionStreamSentinel.flush());
  }

  async endInput(): Promise<void> {
    await this.flush();
    await this.inputStream.close();
  }

  async close(): Promise<void> {
    if (!this.inputStream.closed) await this.inputStream.close();
  }
}

/**
 * Write the audio frame to the output data array and return the new start index
 * and the number of samples written.
 */
function writeToInferenceS16Data(
  frame: AudioFrame,
  startIdx: number,
  outData: Int16Array,
  maxAudioDuration: number,
): { startIdx: number; samplesWritten: number } {
  const maxWindowSize = Math.floor(maxAudioDuration * frame.sampleRate);

  if (frame.samplesPerChannel > outData.length) {
    throw new Error('frame samples are greater than the max window size');
  }

  // Shift the data to the left if the window would overflow
  const shift = startIdx + frame.samplesPerChannel - maxWindowSize;
  if (shift > 0) {
    outData.copyWithin(0, shift, startIdx);
    startIdx -= shift;
  }

  // Get the frame data as Int16Array
  const frameData = new Int16Array(
    frame.data.buffer,
    frame.data.byteOffset,
    frame.samplesPerChannel * frame.channels,
  );

  if (frame.channels > 1) {
    // Mix down multiple channels to mono by averaging
    for (let i = 0; i < frame.samplesPerChannel; i++) {
      let sum = 0;
      for (let ch = 0; ch < frame.channels; ch++) {
        sum += frameData[i * frame.channels + ch] ?? 0;
      }
      outData[startIdx + i] = Math.floor(sum / frame.channels);
    }
  } else {
    // Single channel - copy directly
    outData.set(frameData, startIdx);
  }

  startIdx += frame.samplesPerChannel;
  return { startIdx, samplesWritten: frame.samplesPerChannel };
}
