// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type { Span } from '@opentelemetry/api';
import { log } from '../../log.js';
import type { InterruptionMetrics } from '../../metrics/base.js';
import { Chan } from '../../stream/chan.js';
import { traceTypes } from '../../telemetry/index.js';
import { FRAMES_PER_SECOND, apiConnectDefaults } from './defaults.js';
import { createHttpTransport } from './http_transport.js';
import { InterruptionCacheEntry } from './interruption_cache_entry.js';
import type { AdaptiveInterruptionDetector } from './interruption_detector.js';
import {
  type AgentSpeechEnded,
  type AgentSpeechStarted,
  type ApiConnectOptions,
  type Flush,
  type InterruptionOptions,
  type InterruptionSentinel,
  type OverlapSpeechEnded,
  type OverlapSpeechStarted,
  type OverlappingSpeechEvent,
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
    speechDuration: number,
    startedAt: number,
    userSpeakingSpan?: Span,
  ): OverlapSpeechStarted {
    return { type: 'overlap-speech-started', speechDuration, startedAt, userSpeakingSpan };
  }

  static overlapSpeechEnded(endedAt: number): OverlapSpeechEnded {
    return { type: 'overlap-speech-ended', endedAt };
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
  private inputChan: Chan<InterruptionSentinel | AudioFrame>;

  private eventStream: AsyncIterable<OverlappingSpeechEvent>;

  private resampler?: AudioResampler;

  private numRequests = 0;

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
    this.inputChan = new Chan<InterruptionSentinel | AudioFrame>();

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

    this.eventStream = this.setupPipeline();
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

  private setupPipeline(): AsyncIterable<OverlappingSpeechEvent> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    let agentSpeechStarted = false;
    let startIdx = 0;
    let accumulatedSamples = 0;
    let overlapSpeechStarted = false;
    let overlapCount = 0;
    const cache = new BoundedCache<number, InterruptionCacheEntry>(10);
    const inferenceS16Data = new Int16Array(
      Math.ceil(this.options.maxAudioDurationInS * this.options.sampleRate),
    ).fill(0);

    // State accessors for transport
    const getState = () => ({
      overlapSpeechStarted,
      overlapSpeechStartedAt: this.overlapSpeechStartedAt,
      cache,
      overlapCount,
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

    const onRequestSent = () => {
      this.numRequests++;
    };

    const getAndResetNumRequests = (): number => {
      const n = this.numRequests;
      this.numRequests = 0;
      return n;
    };

    // Audio transform: process input frames/sentinels and output audio slices or events
    const audioTransform = async function* (
      source: AsyncIterable<InterruptionSentinel | AudioFrame>,
    ): AsyncIterable<Int16Array | OverlappingSpeechEvent> {
      for await (const chunk of source) {
        if (chunk instanceof AudioFrame) {
          if (!agentSpeechStarted) {
            continue;
          }
          if (self.options.sampleRate !== chunk.sampleRate) {
            self.logger.error('the sample rate of the input frames must be consistent');
            throw new Error('the sample rate of the input frames must be consistent');
          }
          const result = writeToInferenceS16Data(
            chunk,
            startIdx,
            inferenceS16Data,
            self.options.maxAudioDurationInS,
          );
          startIdx = result.startIdx;
          accumulatedSamples += result.samplesWritten;

          if (
            accumulatedSamples >=
              Math.floor(self.options.detectionIntervalInS * self.options.sampleRate) &&
            overlapSpeechStarted
          ) {
            const audioSlice = inferenceS16Data.slice(0, startIdx);
            accumulatedSamples = 0;
            yield audioSlice;
          }
        } else if (chunk.type === 'agent-speech-started') {
          self.logger.debug('agent speech started');
          agentSpeechStarted = true;
          overlapSpeechStarted = false;
          self.overlapSpeechStartedAt = undefined;
          accumulatedSamples = 0;
          overlapCount = 0;
          startIdx = 0;
          self.numRequests = 0;
          cache.clear();
        } else if (chunk.type === 'agent-speech-ended') {
          self.logger.debug('agent speech ended');
          agentSpeechStarted = false;
          overlapSpeechStarted = false;
          self.overlapSpeechStartedAt = undefined;
          accumulatedSamples = 0;
          overlapCount = 0;
          startIdx = 0;
          self.numRequests = 0;
          cache.clear();
        } else if (chunk.type === 'overlap-speech-started' && agentSpeechStarted) {
          self.overlapSpeechStartedAt = chunk.startedAt;
          self.userSpeakingSpan = chunk.userSpeakingSpan;
          self.logger.debug('overlap speech started, starting interruption inference');
          overlapSpeechStarted = true;
          accumulatedSamples = 0;
          overlapCount += 1;
          if (overlapCount <= 1) {
            const keepSize =
              Math.round((chunk.speechDuration / 1000) * self.options.sampleRate) +
              Math.round(self.options.audioPrefixDurationInS * self.options.sampleRate);
            const shiftCount = Math.max(0, startIdx - keepSize);
            inferenceS16Data.copyWithin(0, shiftCount, startIdx);
            startIdx -= shiftCount;
          }
          cache.clear();
        } else if (chunk.type === 'overlap-speech-ended') {
          self.logger.debug('overlap speech ended');
          if (overlapSpeechStarted) {
            self.userSpeakingSpan = undefined;
            let latestEntry = cache.pop(
              (entry) => entry.totalDurationInS !== undefined && entry.totalDurationInS > 0,
            );
            if (!latestEntry) {
              self.logger.debug('no request made for overlap speech');
              latestEntry = InterruptionCacheEntry.default();
            }
            const e = latestEntry ?? InterruptionCacheEntry.default();
            const event: OverlappingSpeechEvent = {
              type: 'overlapping_speech',
              detectedAt: chunk.endedAt,
              isInterruption: false,
              overlapStartedAt: self.overlapSpeechStartedAt,
              speechInput: e.speechInput,
              probabilities: e.probabilities,
              totalDurationInS: e.totalDurationInS,
              detectionDelayInS: e.detectionDelayInS,
              predictionDurationInS: e.predictionDurationInS,
              probability: e.probability,
              numRequests: getAndResetNumRequests(),
            };
            yield event;
            overlapSpeechStarted = false;
            accumulatedSamples = 0;
          }
          self.overlapSpeechStartedAt = undefined;
        } else if (chunk.type === 'flush') {
          // no-op
        }
      }
    };

    // Transport layer (HTTP or WebSocket based on useProxy)
    const transportOptions = this.transportOptions;

    let transportFn: (
      source: AsyncIterable<Int16Array | OverlappingSpeechEvent>,
    ) => AsyncIterable<OverlappingSpeechEvent>;
    if (this.options.useProxy) {
      const wsResult = createWsTransport(
        transportOptions,
        getState,
        setState,
        handleSpanUpdate,
        onRequestSent,
        getAndResetNumRequests,
      );
      transportFn = wsResult.transport;
      this.wsReconnect = wsResult.reconnect;
    } else {
      transportFn = createHttpTransport(
        transportOptions,
        getState,
        setState,
        handleSpanUpdate,
        getAndResetNumRequests,
      );
    }

    // Event emitter: emit model events and metrics for each overlapping speech event
    const eventEmit = async function* (
      source: AsyncIterable<OverlappingSpeechEvent>,
    ): AsyncIterable<OverlappingSpeechEvent> {
      for await (const event of source) {
        self.model.emit('overlapping_speech', event);

        const metrics: InterruptionMetrics = {
          type: 'interruption_metrics',
          timestamp: event.detectedAt,
          totalDuration: event.totalDurationInS * 1000,
          predictionDuration: event.predictionDurationInS * 1000,
          detectionDelay: event.detectionDelayInS * 1000,
          numInterruptions: event.isInterruption ? 1 : 0,
          numBackchannels: event.isInterruption ? 0 : 1,
          numRequests: event.numRequests,
          metadata: {
            modelProvider: self.model.provider,
            modelName: self.model.model,
          },
        };
        self.model.emit('metrics_collected', metrics);

        yield event;
      }
    };

    // Pipeline: inputChan -> audioTransform -> transport -> eventEmit
    return eventEmit(transportFn(audioTransform(this.inputChan)));
  }

  private ensureInputNotEnded() {
    if (this.inputChan.closed) {
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

  stream(): AsyncIterable<OverlappingSpeechEvent> {
    return this.eventStream;
  }

  async pushFrame(frame: InterruptionSentinel | AudioFrame): Promise<void> {
    this.ensureStreamsNotEnded();
    if (!(frame instanceof AudioFrame)) {
      await this.inputChan.send(frame);
    } else if (this.options.sampleRate !== frame.sampleRate) {
      const resampler = this.getResamplerFor(frame.sampleRate);
      if (resampler.inputRate !== frame.sampleRate) {
        throw new Error('the sample rate of the input frames must be consistent');
      }
      for (const resampledFrame of resampler.push(frame)) {
        await this.inputChan.send(resampledFrame);
      }
    } else {
      await this.inputChan.send(frame);
    }
  }

  async flush(): Promise<void> {
    this.ensureStreamsNotEnded();
    await this.inputChan.send(InterruptionStreamSentinel.flush());
  }

  async endInput(): Promise<void> {
    await this.flush();
    this.inputChan.close();
  }

  async close(): Promise<void> {
    if (!this.inputChan.closed) this.inputChan.close();
    this.model.removeStream(this);
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
