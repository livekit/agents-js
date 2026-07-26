// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type { Span } from '@opentelemetry/api';
import { type ReadableStream, TransformStream } from 'stream/web';
import { asAudioFrame, describeUnknownChunk } from '../../audio_frame_guard.js';
import { log } from '../../log.js';
import type { InterruptionMetrics } from '../../metrics/base.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { traceTypes } from '../../telemetry/index.js';
import { FRAMES_PER_SECOND, apiConnectDefaults } from './defaults.js';
import type { InterruptionDetectionError } from './errors.js';
import { InterruptionCacheEntry } from './interruption_cache_entry.js';
import type { AdaptiveInterruptionDetector } from './interruption_detector.js';
import {
  type AgentSpeechEnded,
  type AgentSpeechResumed,
  type AgentSpeechStarted,
  type ApiConnectOptions,
  type Flush,
  type InterruptionAudioSlice,
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
  AgentSpeechResumed,
  AgentSpeechStarted,
  ApiConnectOptions,
  Flush,
  InterruptionSentinel,
  OverlapSpeechEnded,
  OverlapSpeechStarted,
};

/** Minimum gap between repeat reports of chunks the transform could not classify. */
const DISCARDED_CHUNK_LOG_INTERVAL = 10_000;

/** Snapshot of an overlap that is still being classified. */
export interface ActiveOverlap {
  startedAt: number;
  userSpeakingSpan?: Span;
}

export class InterruptionStreamSentinel {
  static agentSpeechStarted(): AgentSpeechStarted {
    return { type: 'agent-speech-started' };
  }

  static agentSpeechEnded(): AgentSpeechEnded {
    return { type: 'agent-speech-ended' };
  }

  static agentSpeechResumed(overlap?: ActiveOverlap): AgentSpeechResumed {
    return {
      type: 'agent-speech-resumed',
      overlapStartedAt: overlap?.startedAt,
      userSpeakingSpan: overlap?.userSpeakingSpan,
    };
  }

  static overlapSpeechStarted(
    speechDuration: number,
    startedAt: number,
    userSpeakingSpan?: Span,
  ): OverlapSpeechStarted {
    return { type: 'overlap-speech-started', speechDuration, startedAt, userSpeakingSpan };
  }

  static overlapSpeechEnded(endedAt: number, agentEnded = false): OverlapSpeechEnded {
    return { type: 'overlap-speech-ended', endedAt, agentEnded };
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

  private eventStream: ReadableStream<OverlappingSpeechEvent>;

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

  private wsClose?: () => void;

  // The overlap flag lives in the setupTransform() closure; this exposes it for `activeOverlap`.
  private readOverlapSpeechStarted?: () => boolean;

  // Mutable transport options that can be updated via updateOptions()
  private transportOptions: {
    baseUrl: string;
    apiKey: string;
    apiSecret: string;
    sampleRate: number;
    threshold?: number;
    minFrames: number;
    timeout: number;
    connectTimeout: number;
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
      connectTimeout: this.apiOptions.timeout,
      maxRetries: this.apiOptions.maxRetries,
    };

    this.eventStream = this.setupTransform();
  }

  /**
   * The overlap this stream is currently classifying, if any.
   *
   * Unlike Python — where the equivalent flags are attributes on the stream instance and a
   * reconnect leaves them alone — every retry here builds a new stream and drops the state held in
   * `setupTransform()`. Callers that recreate the stream use this to hand the in-progress overlap
   * to its replacement via {@link InterruptionStreamSentinel.agentSpeechResumed}.
   */
  get activeOverlap(): ActiveOverlap | undefined {
    if (!this.readOverlapSpeechStarted?.() || this.overlapSpeechStartedAt === undefined) {
      return undefined;
    }
    return { startedAt: this.overlapSpeechStartedAt, userSpeakingSpan: this.userSpeakingSpan };
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
    // Trigger WebSocket reconnection to apply updated settings.
    if (this.wsReconnect) {
      await this.wsReconnect();
    }
  }

  private setupTransform(): ReadableStream<OverlappingSpeechEvent> {
    let agentSpeechStarted = false;
    let startIdx = 0;
    let accumulatedSamples = 0;
    let overlapSpeechStarted = false;
    let overlapCount = 0;
    // Monotonic across the life of the stream — unlike `overlapCount`, which restarts each agent
    // turn — so a slice cut for an earlier overlap can never be mistaken for the current one.
    let overlapGeneration = 0;
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
    this.readOverlapSpeechStarted = () => overlapSpeechStarted;
    const handleSpanUpdate = (entry: InterruptionCacheEntry) => {
      if (this.userSpeakingSpan) {
        updateUserSpeakingSpan(this.userSpeakingSpan, entry);
        this.userSpeakingSpan = undefined;
      }
    };

    // A slice is sent unconditionally once cut, so the send can land after its overlap closed and
    // the next one opened. Charging it to whatever overlap is open at send time would hand a later
    // overlap a request it never made, which is exactly what `numRequests: 0` is meant to detect.
    const onRequestSent = (sliceOverlapGeneration: number) => {
      if (sliceOverlapGeneration !== overlapGeneration) return;
      this.numRequests++;
    };

    const getAndResetNumRequests = (): number => {
      const n = this.numRequests;
      this.numRequests = 0;
      return n;
    };

    // A chunk that is neither audio nor a sentinel used to fall off the end of the dispatch below
    // and vanish — no accept, no drop, no counter. Audio arrives at ~100 chunks/s, so a log per
    // chunk would be unusable: report the first one at once, then at most one per interval,
    // carrying the running total so the scale of the loss is visible.
    let discardedChunks = 0;
    let discardedChunkLoggedAt = 0;
    const reportDiscardedChunk = (chunk: unknown) => {
      discardedChunks++;
      const now = Date.now();
      if (discardedChunks > 1 && now - discardedChunkLoggedAt < DISCARDED_CHUNK_LOG_INTERVAL) {
        return;
      }
      discardedChunkLoggedAt = now;
      this.logger.error(
        { ...describeUnknownChunk(chunk), discardedChunks },
        'interruption stream discarded a chunk that is neither an audio frame nor a known ' +
          'sentinel; interruption detection is running blind for as long as this continues',
      );
    };

    // First transform: process input frames/sentinels and output audio slices or events
    const audioTransformer = new TransformStream<
      InterruptionSentinel | AudioFrame,
      InterruptionAudioSlice | OverlappingSpeechEvent
    >(
      {
        transform: (chunk, controller) => {
          const frame = asAudioFrame(chunk);
          if (frame) {
            if (!agentSpeechStarted) {
              return;
            }
            if (this.options.sampleRate !== frame.sampleRate) {
              controller.error('the sample rate of the input frames must be consistent');
              this.logger.error('the sample rate of the input frames must be consistent');
              return;
            }
            const result = writeToInferenceS16Data(
              frame,
              startIdx,
              inferenceS16Data,
              this.options.maxAudioDurationInS,
            );
            startIdx = result.startIdx;
            accumulatedSamples += result.samplesWritten;

            if (
              accumulatedSamples >=
                Math.floor(this.options.detectionIntervalInS * this.options.sampleRate) &&
              overlapSpeechStarted
            ) {
              const audioSlice = inferenceS16Data.slice(0, startIdx);
              accumulatedSamples = 0;
              controller.enqueue({
                type: 'audio-slice',
                audio: audioSlice,
                overlapGeneration,
              });
            }
            return;
          }

          // Not audio, so it should be a sentinel — but `chunk` is only typed as one, and an
          // unrecognised object reaching here is exactly the failure this switch exists to
          // surface, so the `default` below has to be a real runtime guard and not just the
          // compile-time exhaustiveness check.
          const sentinel = chunk as InterruptionSentinel;
          switch (sentinel.type) {
            case 'agent-speech-started': {
              // One agent turn can span several speech segments — a queued SpeechHandle, or the
              // reply that follows a tool call — and `AgentActivity.onPipelineReplyDone` only
              // reports `agent-speech-ended` once the speech queue has drained. The later
              // segments therefore arrive here with no end in between. Resetting on those would
              // strand an overlap the user is still in the middle of: `overlapSpeechStarted` is
              // the gate that lets their audio reach the gateway at all, and only a VAD
              // start-of-speech can raise it again — which never comes for speech that is
              // already under way.
              if (agentSpeechStarted && overlapSpeechStarted) {
                this.logger.debug(
                  'agent speech continued into a new segment, keeping open overlap',
                );
              } else {
                this.logger.debug('agent speech started');
                agentSpeechStarted = true;
                overlapSpeechStarted = false;
                this.overlapSpeechStartedAt = undefined;
                accumulatedSamples = 0;
                overlapCount = 0;
                startIdx = 0;
                this.numRequests = 0;
                cache.clear();
              }
              break;
            }
            case 'agent-speech-resumed': {
              // This stream replaces one the transport failover tore down. Adopt what the
              // previous stream knew instead of treating it as a new turn; everything else is
              // already at its freshly-constructed value.
              this.logger.debug(
                { overlapStartedAt: sentinel.overlapStartedAt },
                'resuming agent speech on a replacement interruption stream',
              );
              agentSpeechStarted = true;
              if (sentinel.overlapStartedAt !== undefined) {
                overlapSpeechStarted = true;
                overlapCount = 1;
                this.overlapSpeechStartedAt = sentinel.overlapStartedAt;
                this.userSpeakingSpan = sentinel.userSpeakingSpan;
              }
              break;
            }
            case 'agent-speech-ended': {
              this.logger.debug('agent speech ended');
              agentSpeechStarted = false;
              overlapSpeechStarted = false;
              this.overlapSpeechStartedAt = undefined;
              accumulatedSamples = 0;
              overlapCount = 0;
              startIdx = 0;
              this.numRequests = 0;
              cache.clear();
              break;
            }
            case 'overlap-speech-started': {
              // An overlap only means something while the agent holds the floor.
              if (!agentSpeechStarted) break;
              this.overlapSpeechStartedAt = sentinel.startedAt;
              this.userSpeakingSpan = sentinel.userSpeakingSpan;
              this.logger.debug('overlap speech started, starting interruption inference');
              overlapSpeechStarted = true;
              accumulatedSamples = 0;
              overlapCount += 1;
              overlapGeneration += 1;
              if (overlapCount <= 1) {
                const keepSize =
                  Math.round((sentinel.speechDuration / 1000) * this.options.sampleRate) +
                  Math.round(this.options.audioPrefixDurationInS * this.options.sampleRate);
                const shiftCount = Math.max(0, startIdx - keepSize);
                inferenceS16Data.copyWithin(0, shiftCount, startIdx);
                startIdx -= shiftCount;
              }
              cache.clear();
              break;
            }
            case 'overlap-speech-ended': {
              this.logger.debug('overlap speech ended');
              if (overlapSpeechStarted) {
                this.userSpeakingSpan = undefined;
                let latestEntry = cache.pop(
                  (entry) => entry.totalDurationInS !== undefined && entry.totalDurationInS > 0,
                );
                const numRequests = getAndResetNumRequests();
                if (!latestEntry) {
                  // The verdict below is a fallback, not a model decision. Warn rather than
                  // debug: without this, an unanswered overlap is indistinguishable from a
                  // genuine low-probability backchannel in production logs.
                  this.logger.warn(
                    {
                      overlapDuration:
                        this.overlapSpeechStartedAt !== undefined
                          ? sentinel.endedAt - this.overlapSpeechStartedAt
                          : undefined,
                      numRequests,
                      accumulatedSamples,
                      agentSpeechStarted,
                      agentEnded: sentinel.agentEnded,
                    },
                    'no interruption inference result for overlap speech, defaulting to backchannel',
                  );
                  latestEntry = InterruptionCacheEntry.default();
                }
                const e = latestEntry ?? InterruptionCacheEntry.default();
                const event: OverlappingSpeechEvent = {
                  type: 'overlapping_speech',
                  detectedAt: sentinel.endedAt,
                  isInterruption: false,
                  agentEnded: sentinel.agentEnded,
                  overlapStartedAt: this.overlapSpeechStartedAt,
                  speechInput: e.speechInput,
                  probabilities: e.probabilities,
                  totalDurationInS: e.totalDurationInS,
                  detectionDelayInS: e.detectionDelayInS,
                  predictionDurationInS: e.predictionDurationInS,
                  probability: e.probability,
                  numRequests,
                };
                controller.enqueue(event);
                overlapSpeechStarted = false;
                accumulatedSamples = 0;
              }
              this.overlapSpeechStartedAt = undefined;
              break;
            }
            case 'flush':
              break;
            default: {
              // `never` at compile time, so a new sentinel cannot be added without handling it
              // here. At runtime this is reached by anything the stream cannot classify, which
              // used to be dropped in silence.
              const unhandled: never = sentinel;
              reportDiscardedChunk(unhandled);
              break;
            }
          }
        },
      },
      { highWaterMark: 32 },
      { highWaterMark: 32 },
    );

    // Second transform: WebSocket transport layer.
    const transportOptions = this.transportOptions;

    const wsResult = createWsTransport(
      transportOptions,
      getState,
      setState,
      handleSpanUpdate,
      onRequestSent,
      getAndResetNumRequests,
    );
    const transport = wsResult.transport;
    this.wsReconnect = wsResult.reconnect;
    this.wsClose = wsResult.close;

    const eventEmitter = new TransformStream<OverlappingSpeechEvent, OverlappingSpeechEvent>({
      transform: (chunk, controller) => {
        // Once per overlap. `numRequests: 0` here means the model was never asked, which is what
        // distinguishes "scored below the threshold" from "never classified".
        this.logger.debug(
          {
            isInterruption: chunk.isInterruption,
            probability: chunk.probability,
            numRequests: chunk.numRequests,
            agentEnded: chunk.agentEnded,
            totalDuration: chunk.totalDurationInS * 1000,
            detectionDelay: chunk.detectionDelayInS * 1000,
          },
          'interruption verdict',
        );
        this.model.emit('overlapping_speech', chunk);

        const metrics: InterruptionMetrics = {
          type: 'interruption_metrics',
          timestamp: chunk.detectedAt,
          totalDuration: chunk.totalDurationInS * 1000,
          predictionDuration: chunk.predictionDurationInS * 1000,
          detectionDelay: chunk.detectionDelayInS * 1000,
          numInterruptions: chunk.isInterruption ? 1 : 0,
          numBackchannels: chunk.isInterruption ? 0 : 1,
          numRequests: chunk.numRequests,
          metadata: {
            modelProvider: this.model.provider,
            modelName: this.model.model,
          },
        };
        this.model.emit('metrics_collected', metrics);

        controller.enqueue(chunk);
      },
    });

    // Pipeline: input -> audioTransformer -> transport -> eventEmitter -> eventStream
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

  stream(): ReadableStream<OverlappingSpeechEvent> {
    return this.eventStream;
  }

  async pushFrame(frame: InterruptionSentinel | AudioFrame): Promise<void> {
    this.ensureStreamsNotEnded();
    // Audio is recognised by shape, not by constructor identity: a frame built by a second copy
    // of @livekit/rtc-node used to fail the check and be written through as if it were a
    // sentinel, skipping the resampler on the way to a transform that then discarded it.
    const audioFrame = asAudioFrame(frame);
    if (!audioFrame) {
      return this.inputStream.write(frame as InterruptionSentinel);
    } else if (this.options.sampleRate !== audioFrame.sampleRate) {
      const resampler = this.getResamplerFor(audioFrame.sampleRate);
      if (resampler.inputRate !== audioFrame.sampleRate) {
        throw new Error('the sample rate of the input frames must be consistent');
      }
      for (const resampledFrame of resampler.push(audioFrame)) {
        await this.inputStream.write(resampledFrame);
      }
    } else {
      await this.inputStream.write(audioFrame);
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
    try {
      if (!this.inputStream.closed) await this.inputStream.close();
    } finally {
      this.wsClose?.();
      this.resampler?.close();
      this.model.removeStream(this);
    }
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
