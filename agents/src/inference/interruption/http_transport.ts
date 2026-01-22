import { ofetch } from 'ofetch';
import { TransformStream } from 'stream/web';
import { log } from '../../log.js';
import { createAccessToken } from '../utils.js';
import {
  InterruptionCacheEntry,
  type InterruptionEvent,
  InterruptionEventType,
} from './interruption.js';

export interface PostOptions {
  baseUrl: string;
  token: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface PredictOptions {
  threshold: number;
  minFrames: number;
}

export interface PredictEndpointResponse {
  created_at: number;
  is_bargein: boolean;
  probabilities: number[];
}

export interface PredictResponse {
  createdAt: number;
  isBargein: boolean;
  probabilities: number[];
  predictionDurationInS: number;
}

export async function predictHTTP(
  data: Int16Array,
  predictOptions: PredictOptions,
  options: PostOptions,
): Promise<PredictResponse> {
  const createdAt = performance.now();
  const url = new URL(`/bargein`, options.baseUrl);
  url.searchParams.append('threshold', predictOptions.threshold.toString());
  url.searchParams.append('min_frames', predictOptions.minFrames.toFixed());
  url.searchParams.append('created_at', createdAt.toFixed());

  const { created_at, is_bargein, probabilities } = await ofetch<PredictEndpointResponse>(
    url.toString(),
    {
      retry: 1,
      retryDelay: () => {
        // TODO backoff
        return 500;
      },
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${options.token}`,
      },
      signal: options.signal,
      timeout: options.timeout,
      method: 'POST',
      body: data,
    },
  );

  return {
    createdAt: created_at,
    isBargein: is_bargein,
    probabilities,
    predictionDurationInS: (performance.now() - createdAt) / 1000,
  };
}

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  threshold: number;
  minFrames: number;
  timeout: number;
}

export interface HttpTransportState {
  overlapSpeechStarted: boolean;
  overlapSpeechStartedAt: number | undefined;
  cache: Map<number, InterruptionCacheEntry>;
}

/**
 * Creates an HTTP transport TransformStream for interruption detection.
 *
 * This transport receives Int16Array audio slices and outputs InterruptionEvents.
 * Each audio slice triggers an HTTP POST request.
 */
export function createHttpTransport(
  options: HttpTransportOptions,
  getState: () => HttpTransportState,
  setState: (partial: Partial<HttpTransportState>) => void,
  updateUserSpeakingSpan?: (entry: InterruptionCacheEntry) => void,
): TransformStream<Int16Array | InterruptionEvent, InterruptionEvent> {
  const logger = log();

  return new TransformStream<Int16Array | InterruptionEvent, InterruptionEvent>(
    {
      async transform(chunk, controller) {
        // Pass through InterruptionEvents unchanged
        if (!(chunk instanceof Int16Array)) {
          controller.enqueue(chunk);
          return;
        }

        const state = getState();
        if (!state.overlapSpeechStartedAt) return;

        try {
          const resp = await predictHTTP(
            chunk,
            { threshold: options.threshold, minFrames: options.minFrames },
            {
              baseUrl: options.baseUrl,
              timeout: options.timeout,
              token: await createAccessToken(options.apiKey, options.apiSecret),
            },
          );

          const { createdAt, isBargein, probabilities, predictionDurationInS } = resp;
          const entry = new InterruptionCacheEntry({
            createdAt,
            probabilities,
            isInterruption: isBargein,
            speechInput: chunk,
            totalDurationInS: (performance.now() - createdAt) / 1000,
            detectionDelayInS: (Date.now() - state.overlapSpeechStartedAt) / 1000,
            predictionDurationInS,
          });
          state.cache.set(createdAt, entry);

          if (state.overlapSpeechStarted && entry.isInterruption) {
            if (updateUserSpeakingSpan) {
              updateUserSpeakingSpan(entry);
            }
            const event: InterruptionEvent = {
              type: InterruptionEventType.INTERRUPTION,
              timestamp: Date.now(),
              overlapSpeechStartedAt: state.overlapSpeechStartedAt,
              isInterruption: entry.isInterruption,
              speechInput: entry.speechInput,
              probabilities: entry.probabilities,
              totalDurationInS: entry.totalDurationInS,
              predictionDurationInS: entry.predictionDurationInS,
              detectionDelayInS: entry.detectionDelayInS,
              probability: entry.probability,
            };
            logger.debug(
              {
                detectionDelayInS: entry.detectionDelayInS,
                totalDurationInS: entry.totalDurationInS,
              },
              'interruption detected',
            );
            setState({ overlapSpeechStarted: false });
            controller.enqueue(event);
          }
        } catch (err) {
          logger.error({ err }, 'Failed to send audio data over HTTP');
        }
      },
    },
    { highWaterMark: 2 },
    { highWaterMark: 2 },
  );
}
