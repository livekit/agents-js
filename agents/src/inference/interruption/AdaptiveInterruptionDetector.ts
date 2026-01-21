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
import { type InterruptionDetectionError } from './interruption.js';

type InterruptionCallbacks = {
  interruptionDetected: () => void;
  overlapSpeechDetected: () => void;
  error: (error: InterruptionDetectionError) => void;
};

export interface InterruptionOptions {
  sampleRate: number;
  threshold: number;
  minFrames: number;
  maxAudioDurationInS: number;
  audioPrefixDurationInS: number;
  detectionIntervalInS: number;
  inferenceTimeout: number;
  minInterruptionDurationInS: number;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  useProxy: boolean;
}

export type AdaptiveInterruptionDetectorOptions = Partial<InterruptionOptions>;

export class AdaptiveInterruptionDetector extends (EventEmitter as new () => TypedEventEmitter<InterruptionCallbacks>) {
  options: InterruptionOptions;
  private logger = log();
  private streams: WeakSet<object>; // TODO: Union of InterruptionHttpStream | InterruptionWebSocketStream

  constructor(options: AdaptiveInterruptionDetectorOptions = {}) {
    super();

    const {
      maxAudioDurationInS,
      baseUrl,
      apiKey,
      apiSecret,
      useProxy: useProxyArg,
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
      useProxy = useProxyArg ?? false;
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

    this.streams = new WeakSet();

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
   * Creates a new InterruptionStreamBase for internal use.
   * The stream can receive audio frames and sentinels via pushFrame().
   * Use this when you need direct access to the stream for pushing frames.
   */
  createStream(): InterruptionStreamBase {
    const streamBase = new InterruptionStreamBase(this, {});
    this.streams.add(streamBase);
    // const transformer = new TransformStream<InterruptionEvent, InterruptionEvent>({
    //   transform: (chunk, controller) => {
    //     log().info('adaptive interruption detection stream transformer', chunk);
    //     if (chunk.type === InterruptionEventType.INTERRUPTION) {
    //       this.emit('interruptionDetected'); // TODO payload
    //     } else if (chunk.type === InterruptionEventType.OVERLAP_SPEECH_ENDED) {
    //       this.emit('overlapSpeechDetected'); // TODO payload
    //     }
    //     controller.enqueue(chunk);
    //   },
    // });
    // streamBase.stream().pipeThrough(transformer);
    return streamBase;
  }

  updateOptions(options: { threshold?: number; minInterruptionDurationInS?: number }): void {
    if (options.threshold !== undefined) {
      this.options.threshold = options.threshold;
    }
    if (options.minInterruptionDurationInS !== undefined) {
      this.options.minFrames = Math.ceil(options.minInterruptionDurationInS * FRAMES_PER_SECOND);
    }
  }
}
