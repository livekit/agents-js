// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ApiConnectOptions } from './interruption_stream.js';
import type { InterruptionOptions } from './types.js';

export const MIN_INTERRUPTION_DURATION_IN_S = 0.025 * 2; // 25ms per frame, 2 consecutive frames
export const THRESHOLD = 0.5;
export const MAX_AUDIO_DURATION_IN_S = 3.0;
export const AUDIO_PREFIX_DURATION_IN_S = 0.5;
export const DETECTION_INTERVAL_IN_S = 0.1;
export const REMOTE_INFERENCE_TIMEOUT_IN_S = 1.0;
export const SAMPLE_RATE = 16000;
export const FRAMES_PER_SECOND = 40;
export const FRAME_DURATION_IN_S = 0.025; // 25ms per frame

export const apiConnectDefaults: ApiConnectOptions = {
  maxRetries: 3,
  retryInterval: 2_000,
  timeout: 10_000,
} as const;

/**
 * Calculate the retry interval using exponential backoff with jitter.
 * Matches the Python implementation's _interval_for_retry behavior.
 */
export function intervalForRetry(
  attempt: number,
  baseInterval: number = apiConnectDefaults.retryInterval,
): number {
  // Exponential backoff: baseInterval * 2^attempt with some jitter
  const exponentialDelay = baseInterval * Math.pow(2, attempt);
  // Add jitter (0-25% of the delay)
  const jitter = exponentialDelay * Math.random() * 0.25;
  return exponentialDelay + jitter;
}

// baseUrl and useProxy are resolved dynamically in the constructor
// to respect LIVEKIT_REMOTE_EOT_URL environment variable
export const interruptionOptionDefaults: Omit<InterruptionOptions, 'baseUrl' | 'useProxy'> = {
  sampleRate: SAMPLE_RATE,
  threshold: THRESHOLD,
  minFrames: Math.ceil(MIN_INTERRUPTION_DURATION_IN_S * FRAMES_PER_SECOND),
  maxAudioDurationInS: MAX_AUDIO_DURATION_IN_S,
  audioPrefixDurationInS: AUDIO_PREFIX_DURATION_IN_S,
  detectionIntervalInS: DETECTION_INTERVAL_IN_S,
  inferenceTimeout: REMOTE_INFERENCE_TIMEOUT_IN_S * 1_000,
  apiKey: process.env.LIVEKIT_API_KEY || '',
  apiSecret: process.env.LIVEKIT_API_SECRET || '',
  minInterruptionDurationInS: MIN_INTERRUPTION_DURATION_IN_S,
} as const;
