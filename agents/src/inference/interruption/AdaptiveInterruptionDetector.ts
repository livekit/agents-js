import type { TypedEventEmitter } from '@livekit/typed-emitter';
import EventEmitter from 'events';
import { log } from '../../log.js';
import { InterruptionStreamBase } from './InterruptionStream.js';
import {
  DEFAULT_BASE_URL,
  FRAMES_PER_SECOND,
  SAMPLE_RATE,
  interruptionOptionDefaults,
} from './defaults.js';
import type { InterruptionDetectionError } from './errors.js';
import type { InterruptionEvent, InterruptionOptions } from './types.js';

type InterruptionCallbacks = {
  userInterruptionDetected: (event: InterruptionEvent) => void;
  userNonInterruptionDetected: (event: InterruptionEvent) => void;
  overlapSpeechEnded: (event: InterruptionEvent) => void;
  error: (error: InterruptionDetectionError) => void;
};

export type AdaptiveInterruptionDetectorOptions = Omit<Partial<InterruptionOptions>, 'useProxy'>;

export class AdaptiveInterruptionDetector extends (EventEmitter as new () => TypedEventEmitter<InterruptionCallbacks>) {
  options: InterruptionOptions;
  private readonly _label: string;
  private logger = log();
  // Use Set instead of WeakSet to allow iteration for propagating option updates
  private streams: Set<InterruptionStreamBase> = new Set();

  constructor(options: AdaptiveInterruptionDetectorOptions = {}) {
    super();

    const {
      maxAudioDurationInS,
      baseUrl,
      apiKey,
      apiSecret,
      audioPrefixDurationInS,
      threshold,
      detectionIntervalInS,
      inferenceTimeout,
      minInterruptionDurationInS,
    } = { ...interruptionOptionDefaults, ...options };

    if (maxAudioDurationInS > 3.0) {
      throw new Error('maxAudioDurationInS must be less than or equal to 3.0 seconds');
    }

    const lkBaseUrl = baseUrl ?? process.env.LIVEKIT_REMOTE_EOT_URL ?? DEFAULT_BASE_URL;
    let lkApiKey = apiKey ?? '';
    let lkApiSecret = apiSecret ?? '';
    let useProxy: boolean;

    // use LiveKit credentials if using the default base URL (inference)
    if (lkBaseUrl === DEFAULT_BASE_URL) {
      lkApiKey =
        apiKey ?? process.env.LIVEKIT_INFERENCE_API_KEY ?? process.env.LIVEKIT_API_KEY ?? '';
      if (!lkApiKey) {
        throw new Error(
          'apiKey is required, either as argument or set LIVEKIT_API_KEY environmental variable',
        );
      }

      lkApiSecret =
        apiSecret ??
        process.env.LIVEKIT_INFERENCE_API_SECRET ??
        process.env.LIVEKIT_API_SECRET ??
        '';
      if (!lkApiSecret) {
        throw new Error(
          'apiSecret is required, either as argument or set LIVEKIT_API_SECRET environmental variable',
        );
      }

      useProxy = true;
    } else {
      // Force useProxy to false for custom URLs (matching Python behavior)
      useProxy = false;
    }

    this.options = {
      sampleRate: SAMPLE_RATE,
      threshold,
      minFrames: Math.ceil(minInterruptionDurationInS * FRAMES_PER_SECOND),
      maxAudioDurationInS,
      audioPrefixDurationInS,
      detectionIntervalInS,
      inferenceTimeout,
      baseUrl: lkBaseUrl,
      apiKey: lkApiKey,
      apiSecret: lkApiSecret,
      useProxy,
      minInterruptionDurationInS,
    };

    this._label = `${this.constructor.name}`;

    this.logger.debug(
      {
        baseUrl: this.options.baseUrl,
        detectionIntervalInS: this.options.detectionIntervalInS,
        audioPrefixDurationInS: this.options.audioPrefixDurationInS,
        maxAudioDurationInS: this.options.maxAudioDurationInS,
        minFrames: this.options.minFrames,
        threshold: this.options.threshold,
        inferenceTimeout: this.options.inferenceTimeout,
        useProxy: this.options.useProxy,
      },
      'adaptive interruption detector initialized',
    );
  }

  /**
   * The model identifier for this detector.
   */
  get model(): string {
    return 'adaptive interruption';
  }

  /**
   * The provider identifier for this detector.
   */
  get provider(): string {
    return 'livekit';
  }

  /**
   * The label for this detector instance.
   */
  get label(): string {
    return this._label;
  }

  /**
   * The sample rate used for audio processing.
   */
  get sampleRate(): number {
    return this.options.sampleRate;
  }

  /**
   * Emit an error event from the detector.
   */
  emitError(error: InterruptionDetectionError): void {
    this.emit('error', error);
  }

  /**
   * Creates a new InterruptionStreamBase for internal use.
   * The stream can receive audio frames and sentinels via pushFrame().
   * Use this when you need direct access to the stream for pushing frames.
   */
  createStream(): InterruptionStreamBase {
    const streamBase = new InterruptionStreamBase(this, {});
    this.streams.add(streamBase);
    return streamBase;
  }

  /**
   * Remove a stream from tracking (called when stream is closed).
   */
  removeStream(stream: InterruptionStreamBase): void {
    this.streams.delete(stream);
  }

  /**
   * Update options for the detector and propagate to all active streams.
   * For WebSocket streams, this triggers a reconnection with new settings.
   */
  async updateOptions(options: {
    threshold?: number;
    minInterruptionDurationInS?: number;
  }): Promise<void> {
    if (options.threshold !== undefined) {
      this.options.threshold = options.threshold;
    }
    if (options.minInterruptionDurationInS !== undefined) {
      this.options.minInterruptionDurationInS = options.minInterruptionDurationInS;
      this.options.minFrames = Math.ceil(options.minInterruptionDurationInS * FRAMES_PER_SECOND);
    }

    // Propagate option updates to all active streams (matching Python behavior)
    const updatePromises: Promise<void>[] = [];
    for (const stream of this.streams) {
      updatePromises.push(stream.updateOptions(options));
    }
    await Promise.all(updatePromises);
  }
}
