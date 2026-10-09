// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Speko } from '@spekoai/sdk';

/**
 * Shared Speko SDK client options used by the plugin components.
 *
 * Mirrors the provider-plugin convention used across LiveKit Agents:
 * pass `apiKey`/`baseURL` directly, or pass a preconfigured `client`
 * for tests and advanced connection handling.
 *
 * @public
 */
export interface SpekoClientOptions {
  /** Preconfigured Speko SDK client. Takes precedence over `apiKey` and `baseURL`. */
  client?: Speko;
  /** Speko API key. Defaults to `SPEKO_API_KEY`. */
  apiKey?: string;
  /** Speko API base URL. Defaults to the SDK default, or `SPEKO_BASE_URL` when set. */
  baseURL?: string;
  /** Request timeout in milliseconds for the SDK client. */
  timeout?: number;
}

export function createSpekoClient(options: SpekoClientOptions): Speko {
  if (options.client) return options.client;

  const apiKey = options.apiKey ?? process.env.SPEKO_API_KEY;
  if (!apiKey) {
    throw new Error('Speko API key is required, whether as an argument or as $SPEKO_API_KEY');
  }

  const baseUrl = options.baseURL ?? process.env.SPEKO_BASE_URL;
  return new Speko({
    apiKey,
    ...(baseUrl !== undefined && { baseUrl }),
    ...(options.timeout !== undefined && { timeout: options.timeout }),
  });
}
