// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type { Span } from '@opentelemetry/api';
import { type ReadableStream, TransformStream } from 'stream/web';
import { log } from '../../log.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { traceTypes } from '../../telemetry/index.js';
import type { AdaptiveInterruptionDetector } from './AdaptiveInterruptionDetector.js';
import { InterruptionCacheEntry } from './InterruptionCacheEntry.js';
import { FRAMES_PER_SECOND, apiConnectDefaults } from './defaults.js';
import type { InterruptionDetectionError } from './errors.js';
import { createHttpTransport } from './http_transport.js';
import {
  type AgentSpeechEnded,
  type AgentSpeechStarted,
  type ApiConnectOptions,
  type Flush,
  type InterruptionEvent,
  InterruptionEventType,
  type InterruptionOptions,
  type InterruptionSentinel,
  type OverlapSpeechEnded,
  type OverlapSpeechStarted,
} from './types.js';
import { BoundedCache } from './utils.js';
import { createWsTransport } from './ws_transport.js';

// Re-export sentinel types for backwards compatibility
export type {
  AgentSpeechEnded,
  AgentSpeechStarted,
  ApiConnectOptions,
  Flush,
  InterruptionSentinel,
  OverlapSpeechEnded,
  OverlapSpeechStarted,
};

export class InterruptionStreamSentinel {
  static agentSpeechStarted(): AgentSpeechStarted {
    return { type: 'agent-speech-started' };
  }

  static agentSpeechEnded(): AgentSpeechEnded {
    return { type: 'agent-speech-ended' };
  }

  static overlapSpeechStarted(
    speechDurationInS?: number,
    userSpeakingSpan?: Span,
  ): OverlapSpeechStarted {
    return { type: 'overlap-speech-started', speechDurationInS, userSpeakingSpan };
  }

  static overlapSpeechEnded(): OverlapSpeechEnded {
    return { type: 'overlap-speech-ended' };
  }

  static flush(): Flush {
    return { type: 'flush' };
  }
}

function updateUserSpeakingSpan(span: Span, entry: InterruptionCacheEntry) {
  span.setAttribute(
    traceTypes.ATTR_IS_INTERRUPTION,
    (entry.isInterruption ?? false).toString().toLowerCase(),
  );
  span.setAttribute(traceTypes.ATTR_INTERRUPTION_PROBABILITY, entry.probability);
  span.setAttribute(traceTypes.ATTR_INTERRUPTION_TOTAL_DURATION, entry.totalDurationInS);
  span.setAttribute(traceTypes.ATTR_INTERRUPTION_PREDICTION_DURATION, entry.predictionDurationInS);
  span.setAttribute(traceTypes.ATTR_INTERRUPTION_DETECTION_DELAY, entry.detectionDelayInS);
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

  // Store reconnect function for WebSocket transport
  private wsReconnect?: () => Promise<void>;

  // Mutable transport options that can be updated via updateOptions()
  private transportOptions: {
    baseUrl: string;
    apiKey: string;
    apiSecret: string;
    sampleRate: number;
    threshold: number;
    minFrames: number;
    timeout: number;
    maxRetries: number;
  };

  constructor(model: AdaptiveInterruptionDetector, apiOptions: Partial<ApiConnectOptions>) {
    this.inputStream = createStreamChannel<
      InterruptionSentinel | AudioFrame,
      InterruptionDetectionError
    >();

    this.model = model;
    this.options = { ...model.options };
    this.apiOptions = { ...apiConnectDefaults, ...apiOptions };

    // Initialize mutable transport options
    this.transportOptions = {
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
      apiSecret: this.options.apiSecret,
      sampleRate: this.options.sampleRate,
      threshold: this.options.threshold,
      minFrames: this.options.minFrames,
      timeout: this.options.inferenceTimeout,
      maxRetries: this.apiOptions.maxRetries,
    };

    this.eventStream = this.setupTransform();
  }

  /**
   * Update stream options. For WebSocket transport, this triggers a reconnection.
   */
  async updateOptions(options: {
    threshold?: number;
    minInterruptionDurationInS?: number;
  }): Promise<void> {
    if (options.threshold !== undefined) {
      this.options.threshold = options.threshold;
      this.transportOptions.threshold = options.threshold;
    }
    if (options.minInterruptionDurationInS !== undefined) {
      this.options.minInterruptionDurationInS = options.minInterruptionDurationInS;
      this.options.minFrames = Math.ceil(options.minInterruptionDurationInS * FRAMES_PER_SECOND);
      this.transportOptions.minFrames = this.options.minFrames;
    }
    // Trigger WebSocket reconnection if using proxy (WebSocket transport)
    if (this.options.useProxy && this.wsReconnect) {
      await this.wsReconnect();
    }
  }

  private setupTransform(): ReadableStream<InterruptionEvent> {
    let agentSpeechStarted = false;
    let startIdx = 0;
    let accumulatedSamples = 0;
    let overlapSpeechStarted = false;
    // Use BoundedCache with max_len=10 to prevent unbounded memory growth
    const cache = new BoundedCache<number, InterruptionCacheEntry>(10);
    const inferenceS16Data = new Int16Array(
      Math.ceil(this.options.maxAudioDurationInS * this.options.sampleRate),
    ).fill(0);

    // State accessors for transport
    const getState = () => ({
      overlapSpeechStarted,
      overlapSpeechStartedAt: this.overlapSpeechStartedAt,
      cache,
    });
    const setState = (partial: { overlapSpeechStarted?: boolean }) => {
      if (partial.overlapSpeechStarted !== undefined) {
        overlapSpeechStarted = partial.overlapSpeechStarted;
      }
    };
    const handleSpanUpdate = (entry: InterruptionCacheEntry) => {
      if (this.userSpeakingSpan) {
        updateUserSpeakingSpan(this.userSpeakingSpan, entry);
        this.userSpeakingSpan = undefined;
      }
    };

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
              this.options.maxAudioDurationInS,
            );
            startIdx = result.startIdx;
            accumulatedSamples += result.samplesWritten;

            // Send data for inference when enough samples accumulated during overlap
            if (
              accumulatedSamples >=
                Math.floor(this.options.detectionIntervalInS * this.options.sampleRate) &&
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
              Math.round(chunk.speechDurationInS * this.options.sampleRate) +
                Math.round(this.options.audioPrefixDurationInS * this.options.sampleRate),
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
              // Use pop with predicate to get only completed requests (matching Python behavior)
              // This ensures we don't return incomplete/in-flight requests as the "final" result
              let latestEntry = cache.pop(
                (entry) => entry.totalDurationInS !== undefined && entry.totalDurationInS > 0,
              );
              if (!latestEntry) {
                this.logger.debug('no request made for overlap speech');
                latestEntry = InterruptionCacheEntry.default();
              }
              const event: InterruptionEvent = {
                type: InterruptionEventType.OVERLAP_SPEECH_ENDED,
                timestamp: Date.now(),
                isInterruption: false,
                overlapSpeechStartedAt: this.overlapSpeechStartedAt,
                speechInput: latestEntry.speechInput,
                probabilities: latestEntry.probabilities,
                totalDurationInS: latestEntry.totalDurationInS,
                detectionDelayInS: latestEntry.detectionDelayInS,
                predictionDurationInS: latestEntry.predictionDurationInS,
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

    // Second transform: transport layer (HTTP or WebSocket based on useProxy)
    const transportOptions = this.transportOptions;

    let transport: TransformStream<Int16Array | InterruptionEvent, InterruptionEvent>;
    if (this.options.useProxy) {
      const wsResult = createWsTransport(transportOptions, getState, setState, handleSpanUpdate);
      transport = wsResult.transport;
      this.wsReconnect = wsResult.reconnect;
    } else {
      transport = createHttpTransport(transportOptions, getState, setState, handleSpanUpdate);
    }

    const eventEmitter = new TransformStream<InterruptionEvent, InterruptionEvent>({
      transform: (chunk, controller) => {
        if (chunk.type === InterruptionEventType.INTERRUPTION) {
          this.model.emit('userInterruptionDetected', chunk);
        } else if (chunk.type === InterruptionEventType.OVERLAP_SPEECH_ENDED) {
          this.model.emit('overlapSpeechEnded', chunk);
        }
        controller.enqueue(chunk);
      },
    });

    // Pipeline: input -> audioTransformer -> transport -> eventStream
    return this.inputStream
      .stream()
      .pipeThrough(audioTransformer)
      .pipeThrough(transport)
      .pipeThrough(eventEmitter);
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
        this.overlapSpeechStartedAt = Date.now() - frame.speechDurationInS * 1000;
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
    await this.inputStream.write(InterruptionStreamSentinel.flush());
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
