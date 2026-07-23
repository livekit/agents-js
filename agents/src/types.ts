// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Key used to store timed transcripts in AudioFrame.userdata.
 */
export const USERDATA_TIMED_TRANSCRIPT = 'lk.timed_transcripts';

/**
 * Key used to store when synthesized text was first sent to the TTS provider.
 */
export const USERDATA_TTS_STARTED_TIME = 'lk.tts_started_time';

/**
 * Marker yielded from an LLM node to flush the current audio/text output segment.
 */
export const FlushSentinel = Symbol.for('lk.FlushSentinel');
export type FlushSentinel = typeof FlushSentinel;

/** Indicates that the participant is a simulator for testing purposes. */
export const ATTRIBUTE_SIMULATOR = 'lk.simulator';

/** Job attribute carrying the simulation dispatch proto JSON. */
export const ATTRIBUTE_SIMULATOR_DISPATCH = 'lk.simulator.dispatch';

/** Participant attribute allowing an avatar worker to publish on behalf of the agent. */
export const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';

/** Telemetry metadata key marking the session as a simulation. */
export const ATTRIBUTE_SIMULATION_ENABLED = 'lk.simulation.enabled';

/** Telemetry metadata key requesting PII redaction for the session. */
export const ATTRIBUTE_REDACTION_ENABLED = 'lk.redaction.enabled';

const RECORDING_OPTION_KEYS = ['audio', 'traces', 'logs', 'transcript'] as const;

/** @internal */
export function recordingEnabled(options: Record<string, unknown>): boolean {
  return RECORDING_OPTION_KEYS.some((key) => options[key] === true);
}

/** @internal */
export function isFlushSentinel(value: unknown): value is FlushSentinel {
  return value === FlushSentinel;
}

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
