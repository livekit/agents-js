// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Throws } from '@livekit/throws-transformer/throws';
import { FetchError, ofetch } from 'ofetch';
import { z } from 'zod';
import { APIConnectionError, APIError, APIStatusError, isAPIError } from '../../_exceptions.js';
import { log } from '../../log.js';
import { createAccessToken } from '../utils.js';
import { InterruptionCacheEntry } from './interruption_cache_entry.js';
import type { OverlappingSpeechEvent } from './types.js';
import type { BoundedCache } from './utils.js';

export interface PostOptions {
  baseUrl: string;
  token: string;
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
}

export interface PredictOptions {
  threshold: number;
  minFrames: number;
}

export const predictEndpointResponseSchema = z.object({
  created_at: z.number(),
  is_bargein: z.boolean(),
  probabilities: z.array(z.number()),
});

export type PredictEndpointResponse = z.infer<typeof predictEndpointResponseSchema>;

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
): Promise<Throws<PredictResponse, APIConnectionError | APIStatusError | APIError>> {
  const createdAt = performance.now();
  const url = new URL(`/bargein`, options.baseUrl);
  url.searchParams.append('threshold', predictOptions.threshold.toString());
  url.searchParams.append('min_frames', predictOptions.minFrames.toFixed());
  url.searchParams.append('created_at', createdAt.toFixed());

  try {
    const response = await ofetch(url.toString(), {
      retry: 0,
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${options.token}`,
      },
      signal: options.signal,
      timeout: options.timeout,
      method: 'POST',
      body: data,
    });
    const { created_at, is_bargein, probabilities } = predictEndpointResponseSchema.parse(response);

    return {
      createdAt: created_at,
      isBargein: is_bargein,
      probabilities,
      predictionDurationInS: (performance.now() - createdAt) / 1000,
    };
  } catch (err) {
    if (isAPIError(err)) throw err;
    if (err instanceof FetchError) {
      if (err.statusCode) {
        throw new APIStatusError({
          message: `error during interruption prediction: ${err.message}`,
          options: { statusCode: err.statusCode, body: err.data },
        });
      }
      if (
        err.cause instanceof Error &&
        (err.cause.name === 'TimeoutError' || err.cause.name === 'AbortError')
      ) {
        throw new APIStatusError({
          message: `interruption inference timeout: ${err.message}`,
          options: { statusCode: 408, retryable: false },
        });
      }
      throw new APIConnectionError({
        message: `interruption inference connection error: ${err.message}`,
      });
    }
    throw new APIError(`error during interruption prediction: ${err}`);
  }
}

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  threshold: number;
  minFrames: number;
  timeout: number;
  maxRetries?: number;
}

export interface HttpTransportState {
  overlapSpeechStarted: boolean;
  overlapSpeechStartedAt: number | undefined;
  cache: BoundedCache<number, InterruptionCacheEntry>;
}

export type TransportFn = (
  source: AsyncIterable<Int16Array | OverlappingSpeechEvent>,
) => AsyncIterable<OverlappingSpeechEvent>;

/**
 * Creates an HTTP transport async generator for interruption detection.
 *
 * This transport receives Int16Array audio slices and outputs InterruptionEvents.
 * Each audio slice triggers an HTTP POST request.
 *
 * @param options - Transport options object. This is read on each request, so mutations
 *                  to threshold/minFrames will be picked up dynamically.
 */
export function createHttpTransport(
  options: HttpTransportOptions,
  getState: () => HttpTransportState,
  setState: (partial: Partial<HttpTransportState>) => void,
  updateUserSpeakingSpan?: (entry: InterruptionCacheEntry) => void,
  getAndResetNumRequests?: () => number,
): TransportFn {
  const logger = log();

  return async function* (source) {
    for await (const chunk of source) {
      if (!(chunk instanceof Int16Array)) {
        yield chunk;
        continue;
      }

      const state = getState();
      const overlapSpeechStartedAt = state.overlapSpeechStartedAt;
      if (overlapSpeechStartedAt === undefined || !state.overlapSpeechStarted) continue;

      const resp = await predictHTTP(
        chunk,
        { threshold: options.threshold, minFrames: options.minFrames },
        {
          baseUrl: options.baseUrl,
          timeout: options.timeout,
          maxRetries: options.maxRetries,
          token: await createAccessToken(options.apiKey, options.apiSecret),
        },
      );

      const { createdAt, isBargein, probabilities, predictionDurationInS } = resp;
      const entry = state.cache.setOrUpdate(
        createdAt,
        () => new InterruptionCacheEntry({ createdAt }),
        {
          probabilities,
          isInterruption: isBargein,
          speechInput: chunk,
          totalDurationInS: (performance.now() - createdAt) / 1000,
          detectionDelayInS: (Date.now() - overlapSpeechStartedAt) / 1000,
          predictionDurationInS,
        },
      );

      if (state.overlapSpeechStarted && entry.isInterruption) {
        if (updateUserSpeakingSpan) {
          updateUserSpeakingSpan(entry);
        }
        const event: OverlappingSpeechEvent = {
          type: 'overlapping_speech',
          detectedAt: Date.now(),
          overlapStartedAt: overlapSpeechStartedAt,
          isInterruption: entry.isInterruption,
          speechInput: entry.speechInput,
          probabilities: entry.probabilities,
          totalDurationInS: entry.totalDurationInS,
          predictionDurationInS: entry.predictionDurationInS,
          detectionDelayInS: entry.detectionDelayInS,
          probability: entry.probability,
          numRequests: getAndResetNumRequests?.() ?? 0,
        };
        logger.debug(
          {
            detectionDelayInS: entry.detectionDelayInS,
            totalDurationInS: entry.totalDurationInS,
          },
          'interruption detected',
        );
        setState({ overlapSpeechStarted: false });
        yield event;
      }
    }
  };
}
