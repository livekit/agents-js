import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type { Span } from '@opentelemetry/sdk-trace-base';
import { type ReadableStream, TransformStream, WritableStream } from 'stream/web';
import { log } from '../../log.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
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
  static speechStarted(): AgentSpeechEnded {
    return { type: 'agent-speech-ended' };
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

abstract class InterruptionStreamBase {
  private inputStream: StreamChannel<InterruptionSentinel | AudioFrame, InterruptionDetectionError>;

  private eventStream: StreamChannel<InterruptionEvent, InterruptionDetectionError>;

  private resampler?: AudioResampler;

  private userSpeakingSpan: Span | undefined;

  private overlapSpeechStartedAt: number | undefined;

  private options: InterruptionOptions;

  private apiOptions: ApiConnectOptions;

  private model: AdaptiveInterruptionDetector;

  constructor(model: AdaptiveInterruptionDetector, apiOptions: Partial<ApiConnectOptions>) {
    this.inputStream = createStreamChannel<
      InterruptionSentinel | AudioFrame,
      InterruptionDetectionError
    >();

    this.eventStream = createStreamChannel<InterruptionEvent, InterruptionDetectionError>();

    this.model = model;
    this.options = model.options;
    this.apiOptions = { ...apiConnectDefaults, ...apiOptions };
  }

  private setupTransform() {
    let agentSpeechStarted = false;
    let startIdx = 0;
    let accumulatedSamples = 0;
    let overlapSpeechStarted = false;
    const cache = new Map<number, InterruptionCacheEntry>(); // TODO limit cache size
    const inferenceS16Data = new Int16Array(
      Math.ceil(this.options.maxAudioDuration * this.options.sampleRate),
    ).fill(0);

    const transformer = new TransformStream<InterruptionSentinel | AudioFrame, Int16Array>(
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
              // TODO: send to data channel - dataChan.send(audioSlice);
              accumulatedSamples = 0;
              controller.enqueue(audioSlice);
            }
          } else if (chunk.type === 'agent-speech-started') {
            log().debug('agent speech started');

            agentSpeechStarted = true;
            overlapSpeechStarted = false;
            accumulatedSamples = 0;
            startIdx = 0;
            cache.clear();
          } else if (chunk.type === 'agent-speech-ended') {
            log().debug('agent speech ended');

            agentSpeechStarted = false;
            overlapSpeechStarted = false;
            accumulatedSamples = 0;
            startIdx = 0;
            cache.clear();
          } else if (chunk.type === 'overlap-speech-started' && agentSpeechStarted) {
            this.userSpeakingSpan = chunk.userSpeakingSpan;
            log().debug('overlap speech started, starting interruption inference');
            overlapSpeechStarted = true;
            accumulatedSamples = 0;
            const shiftSize = Math.min(
              startIdx,
              Math.round(chunk.speechDuration * this.options.sampleRate),
            );
            // Shift the buffer: copy the last `shiftSize` samples before startIdx
            // to the beginning of the buffer. This preserves recent audio context
            // (the user's speech that occurred just before overlap was detected).
            inferenceS16Data.copyWithin(0, startIdx - shiftSize, startIdx);
            startIdx = shiftSize;
            cache.clear();
          } else if (chunk.type === 'overlap-speech-ended') {
            log().debug('overlap speech ended');

            if (overlapSpeechStarted) {
              this.userSpeakingSpan = undefined;
              let latestEntry = Array.from(cache.values()).at(-1);
              if (!latestEntry) {
                log().debug('no request made for overlap speech');
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
              this.eventStream.write(event);
            }
          } else if (chunk.type === 'flush') {
            log().debug('flushing');
            // do nothing
          }
        },
      },
      { highWaterMark: Number.MAX_SAFE_INTEGER },
      { highWaterMark: Number.MAX_SAFE_INTEGER },
    );

    const httpPostWriter = new WritableStream<Int16Array>(
      {
        // Implement the sink
        write: async (chunk) => {
          if (this.overlapSpeechStartedAt) {
            return;
          }
          await predictHTTP(
            chunk,
            { threshold: this.options.threshold, minFrames: this.options.minFrames },
            {
              baseUrl: this.options.baseUrl,
              timeout: this.options.inferenceTimeout,
              token: await createAccessToken(),
            },
          );
        },
        close() {
          const listItem = document.createElement('li');
          listItem.textContent = `[MESSAGE RECEIVED] ${result}`;
          list.appendChild(listItem);
        },
        abort(err) {
          console.log('Sink error:', err);
        },
      },
      { highWaterMark: Number.MAX_SAFE_INTEGER },
    );

    this.inputStream.stream().pipeThrough(transformer).pipeTo(httpPostWriter);
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

  get stream(): ReadableStream<InterruptionEvent> {
    return this.eventStream.stream();
  }

  async pushFrame(frame: InterruptionSentinel | AudioFrame): Promise<void> {
    this.ensureStreamsNotEnded();
    if (!(frame instanceof AudioFrame)) {
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
