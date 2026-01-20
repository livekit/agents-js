import type { TypedEventEmitter } from '@livekit/typed-emitter';
import EventEmitter from 'events';
import { type ReadableStream, TransformStream } from 'stream/web';
import { InterruptionStreamBase } from './InterruptionStream.js';
import {
  DEFAULT_BASE_URL,
  FRAMES_PER_SECOND,
  SAMPLE_RATE,
  interruptionOptionDefaults,
} from './defaults.js';
import {
  type InterruptionDetectionError,
  type InterruptionEvent,
  InterruptionEventType,
} from './interruption.js';

type InterruptionCallbacks = {
  interruptionDetected: () => void;
  overlapSpeechDetected: () => void;
  error: (error: InterruptionDetectionError) => void;
};

export interface InterruptionOptions {
  sampleRate: number;
  threshold: number;
  minFrames: number;
  maxAudioDuration: number;
  audioPrefixDuration: number;
  detectionInterval: number;
  inferenceTimeout: number;
  minInterruptionDuration: number;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  useProxy: boolean;
}

export type AdaptiveInterruptionDetectorOptions = Partial<InterruptionOptions>;

export class AdaptiveInterruptionDetector extends (EventEmitter as new () => TypedEventEmitter<InterruptionCallbacks>) {
  options: InterruptionOptions;
  private label: string;
  private streams: WeakSet<object>; // TODO: Union of InterruptionHttpStream | InterruptionWebSocketStream

  constructor(options: AdaptiveInterruptionDetectorOptions = {}) {
    super();

    const {
      maxAudioDuration,
      baseUrl,
      apiKey,
      apiSecret,
      useProxy: useProxyArg,
      audioPrefixDuration,
      threshold,
      detectionInterval,
      inferenceTimeout,
      minInterruptionDuration,
    } = { ...interruptionOptionDefaults, ...options };

    if (maxAudioDuration > 3.0) {
      throw new Error('maxAudioDuration must be less than or equal to 3.0 seconds');
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
      minFrames: Math.ceil(minInterruptionDuration * FRAMES_PER_SECOND),
      maxAudioDuration,
      audioPrefixDuration,
      detectionInterval,
      inferenceTimeout,
      baseUrl: lkBaseUrl,
      apiKey: lkApiKey,
      apiSecret: lkApiSecret,
      useProxy,
      minInterruptionDuration,
    };

    this.label = `${this.constructor.name}`;
    this.streams = new WeakSet();

    console.info('adaptive interruption detector initialized', {
      baseUrl: this.options.baseUrl,
      detectionInterval: this.options.detectionInterval,
      audioPrefixDuration: this.options.audioPrefixDuration,
      maxAudioDuration: this.options.maxAudioDuration,
      minFrames: this.options.minFrames,
      threshold: this.options.threshold,
      inferenceTimeout: this.options.inferenceTimeout,
      useProxy: this.options.useProxy,
    });
  }

  stream(): ReadableStream<InterruptionEvent> {
    const httpStream = new InterruptionStreamBase(this, {});
    this.streams.add(httpStream);
    const transformer = new TransformStream<InterruptionEvent, InterruptionEvent>({
      transform: (chunk, controller) => {
        if (chunk.type === InterruptionEventType.INTERRUPTION) {
          this.emit('interruptionDetected'); // TODO payload
        } else if (chunk.type === InterruptionEventType.OVERLAP_SPEECH_ENDED) {
          this.emit('overlapSpeechDetected'); // TODO payload
        }
        controller.enqueue(chunk);
      },
    });
    const stream = httpStream.stream.pipeThrough(transformer);
    return stream;
  }
}
