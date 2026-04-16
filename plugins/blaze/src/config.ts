// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Blaze Configuration Module
 *
 * Provides centralized configuration for Blaze AI services.
 * All services (STT, TTS, LLM) route through a single gateway URL.
 * Service-specific configuration (language, speaker, etc.) comes from the
 * voicebot ID and is passed as constructor options to each plugin.
 *
 * Values are resolved in priority order:
 *   Explicit options -\> BlazeConfig -\> Environment variables -\> Defaults
 *
 * Environment Variables (prefix: BLAZE_):
 *   BLAZE_API_URL      - Base URL for all Blaze services
 *   BLAZE_API_TOKEN   - Bearer token for authentication
 *   BLAZE_STT_TIMEOUT  - STT timeout in ms (default: 30000)
 *   BLAZE_TTS_TIMEOUT  - TTS timeout in ms (default: 60000)
 *   BLAZE_LLM_TIMEOUT  - LLM timeout in ms (default: 60000)
 */

/** Configuration for Blaze AI services. */
export interface BlazeConfig {
  /** Base URL for all Blaze API services. Default: https://api.blaze.vn */
  apiUrl?: string;
  /** Bearer token for API authentication. */
  authToken?: string;
  /** STT request timeout in milliseconds. Default: 30000 */
  sttTimeout?: number;
  /** TTS request timeout in milliseconds. Default: 60000 */
  ttsTimeout?: number;
  /** LLM request timeout in milliseconds. Default: 60000 */
  llmTimeout?: number;
}

/** Resolved configuration with all values populated. */
export interface ResolvedBlazeConfig {
  apiUrl: string;
  authToken: string;
  sttTimeout: number;
  ttsTimeout: number;
  llmTimeout: number;
}

/** Parse a timeout env var, falling back to a default if the value is missing or non-numeric. */
function parseTimeoutEnv(envVal: string | undefined, defaultMs: number): number {
  if (!envVal) return defaultMs;
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

/** Resolve configuration from options, environment variables, and defaults. */
export function resolveConfig(config?: BlazeConfig): ResolvedBlazeConfig {
  return {
    apiUrl: config?.apiUrl ?? process.env['BLAZE_API_URL'] ?? 'https://api.blaze.vn',
    authToken: config?.authToken ?? process.env['BLAZE_API_TOKEN'] ?? '',
    sttTimeout: config?.sttTimeout ?? parseTimeoutEnv(process.env['BLAZE_STT_TIMEOUT'], 30000),
    ttsTimeout: config?.ttsTimeout ?? parseTimeoutEnv(process.env['BLAZE_TTS_TIMEOUT'], 60000),
    llmTimeout: config?.llmTimeout ?? parseTimeoutEnv(process.env['BLAZE_LLM_TIMEOUT'], 60000),
  };
}

/** Build Authorization header value if token is provided. */
export function buildAuthHeaders(authToken: string): Record<string, string> {
  if (!authToken) return {};
  return { Authorization: `Bearer ${authToken}` };
}

/** Maximum number of retry attempts for transient failures. */
export const MAX_RETRY_COUNT = 3;

/** Base delay in milliseconds for exponential backoff. */
export const RETRY_BASE_DELAY_MS = 2000;

/** Sleep for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Error thrown for non-retryable HTTP errors (4xx client errors).
 * `isRetryableError` returns false for this type, preventing pointless retries.
 */
export class BlazeHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BlazeHttpError';
    this.status = status;
  }
}

/** Check if an error is retryable (not an intentional abort or client error). */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  // 4xx client errors are deterministic failures — retrying won't help
  if (err instanceof BlazeHttpError && err.status < 500) return false;
  return true;
}
