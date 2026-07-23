// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  intervalForRetry,
} from '@livekit/agents';
import { log } from './log.js';

/** @public */
export const DEFAULT_API_URL = 'https://api.d-id.com';

/**
 * Exception thrown when the D-ID plugin or D-ID service errors.
 *
 * @public
 */
export class DIDException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DIDException';
  }
}

/** @public */
export interface JoinSessionTransport {
  /** Transport provider. Always `livekit` for this plugin. */
  provider: 'livekit';
  /** LiveKit server URL the D-ID worker should connect to. */
  server_url: string;
  /** LiveKit JWT for the D-ID worker. */
  token: string;
  /** LiveKit room name to join. */
  room_name: string;
}

/** @public */
export interface JoinSessionAudioConfig {
  /** Sample rate in Hz. Supported values: 16000, 24000, 48000. */
  sample_rate: number;
}

/** @public */
export interface JoinSessionOptions {
  /** D-ID agent id. */
  agentId: string;
  /** Transport configuration passed to the D-ID join endpoint. */
  transport: JoinSessionTransport;
  /** Audio configuration passed to the D-ID join endpoint. */
  audioConfig: JoinSessionAudioConfig;
}

/** @public */
export interface DIDAPIOptions {
  /** D-ID API key. Falls back to `DID_API_KEY`. */
  apiKey?: string;
  /** Override the D-ID API base URL. */
  apiUrl?: string;
  /** API retry/timeout options. */
  connOptions?: APIConnectOptions;
}

/**
 * Thin client for the D-ID HTTP API.
 *
 * @public
 */
export class DIDAPI {
  private apiKey: string;
  private apiUrl: string;
  private connOptions: APIConnectOptions;

  #logger = log();

  constructor(options: DIDAPIOptions = {}) {
    const apiKey = options.apiKey ?? process.env.DID_API_KEY ?? '';
    if (!apiKey) {
      throw new DIDException('DID_API_KEY must be set');
    }

    this.apiKey = apiKey;
    this.apiUrl = options.apiUrl || DEFAULT_API_URL;
    this.connOptions = options.connOptions || DEFAULT_API_CONNECT_OPTIONS;
  }

  async joinSession(options: JoinSessionOptions): Promise<string> {
    const payload: Record<string, unknown> = {
      transport: options.transport,
      audio_config: options.audioConfig,
    };

    const responseData = (await this.post(
      `v2/agents/${options.agentId}/sessions/join`,
      payload,
    )) as { id: string };
    return responseData.id;
  }

  private async post(endpoint: string, payload: Record<string, unknown>): Promise<unknown> {
    const url = `${this.apiUrl}/${endpoint}`;

    for (let i = 0; i <= this.connOptions.maxRetry; i++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.connOptions.timeoutMs),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new APIStatusError({
            message: 'Server returned an error',
            options: { statusCode: response.status, body: { error: text } },
          });
        }

        return await response.json();
      } catch (e) {
        if (e instanceof APIStatusError && !e.retryable) {
          throw e;
        }
        if (e instanceof APIConnectionError) {
          this.#logger.warn({ 'lk.pii.error': e }, 'failed to call d-id api');
        } else {
          this.#logger.error({ 'lk.pii.error': e }, 'failed to call d-id api');
        }

        if (i < this.connOptions.maxRetry) {
          await new Promise((resolve) =>
            setTimeout(resolve, intervalForRetry(this.connOptions, i)),
          );
        }
      }
    }

    throw new APIConnectionError({
      message: 'Failed to call D-ID API after all retries',
    });
  }
}
