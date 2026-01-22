// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Key used to store timed transcripts in AudioFrame.userdata.
 */
export const USERDATA_TIMED_TRANSCRIPT = 'lk.timed_transcripts';

/**
 * Connection options for API calls, controlling retry and timeout behavior.
 */
export interface APIConnectOptions {
  /** Maximum number of retries to connect to the API. Default: 3 */
  maxRetry: number;
  /** Interval between retries to connect to the API in milliseconds. Default: 2000 */
  retryIntervalMs: number;
  /** Timeout for connecting to the API in milliseconds. Default: 10000 */
  timeoutMs: number;
}

export const DEFAULT_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 3,
  retryIntervalMs: 2000,
  timeoutMs: 10000,
};

/**
 * Return the interval for the given number of retries.
 * The first retry is immediate, and then uses specified retryIntervalMs.
 * @internal
 */
export function intervalForRetry(connOptions: APIConnectOptions, numRetries: number): number {
  if (numRetries === 0) {
    return 0.1;
  }
  return connOptions.retryIntervalMs;
}

/**
 * Connection options for the agent session, controlling retry and timeout behavior
 * for STT, LLM, and TTS connections.
 */
export interface SessionConnectOptions {
  /** Connection options for speech-to-text. */
  sttConnOptions?: Partial<APIConnectOptions>;
  /** Connection options for the language model. */
  llmConnOptions?: Partial<APIConnectOptions>;
  /** Connection options for text-to-speech. */
  ttsConnOptions?: Partial<APIConnectOptions>;
  /** Maximum number of consecutive unrecoverable errors from LLM or TTS before closing the session. Default: 3 */
  maxUnrecoverableErrors?: number;
}

/**
 * Resolved session connect options with all values populated.
 * @internal
 */
export interface ResolvedSessionConnectOptions {
  sttConnOptions: APIConnectOptions;
  llmConnOptions: APIConnectOptions;
  ttsConnOptions: APIConnectOptions;
  maxUnrecoverableErrors: number;
}

export const DEFAULT_SESSION_CONNECT_OPTIONS: ResolvedSessionConnectOptions = {
  sttConnOptions: DEFAULT_API_CONNECT_OPTIONS,
  llmConnOptions: DEFAULT_API_CONNECT_OPTIONS,
  ttsConnOptions: DEFAULT_API_CONNECT_OPTIONS,
  maxUnrecoverableErrors: 3,
};
