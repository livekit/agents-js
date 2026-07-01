// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  intervalForRetry,
} from '@livekit/agents';
import { log } from './log.js';

/** @public */
export const DEFAULT_API_URL = 'https://api.protoface.com';

const USER_AGENT = `@livekit/agents-plugin-protoface/${__PACKAGE_VERSION__}`;

/** @public */
export class ProtofaceException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtofaceException';
  }
}

/** @public */
export interface ProtofaceAPIOptions {
  /** Protoface API key. Falls back to the `PROTOFACE_API_KEY` env var. */
  apiKey?: string | null;
  /** Override the Protoface API base URL. */
  apiUrl?: string | null;
  /** API retry/timeout options. */
  connOptions?: APIConnectOptions;
}

/** @public */
export interface StartSessionOptions {
  avatarId: string;
  transport: Record<string, unknown>;
  maxDurationSeconds?: number | null;
}

/** @public */
export type ProtofaceSession = Record<string, unknown> & { id?: string };

/**
 * Async client for the Protoface session API.
 *
 * @public
 */
export class ProtofaceAPI {
  private apiKey: string;
  private apiUrl: string;
  private connOptions: APIConnectOptions;

  #logger = log();

  constructor(options: ProtofaceAPIOptions = {}) {
    const apiKey = options.apiKey ?? process.env.PROTOFACE_API_KEY ?? '';
    if (!apiKey) {
      throw new ProtofaceException(
        'apiKey must be set by passing it to ProtofaceAPI or setting the PROTOFACE_API_KEY environment variable',
      );
    }

    this.apiKey = apiKey;
    this.apiUrl = (options.apiUrl ?? process.env.PROTOFACE_API_URL ?? DEFAULT_API_URL).replace(
      /\/+$/,
      '',
    );
    this.connOptions = options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
  }

  async startSession(options: StartSessionOptions): Promise<ProtofaceSession> {
    const body: Record<string, unknown> = {
      avatar_id: options.avatarId,
      transport: options.transport,
    };
    if (options.maxDurationSeconds != null) {
      body.max_duration_seconds = options.maxDurationSeconds;
    }

    return (await this.json('POST', '/v1/sessions', body)) as ProtofaceSession;
  }

  async endSession(sessionId: string): Promise<Record<string, unknown>> {
    return (await this.json('POST', `/v1/sessions/${sessionId}/end`)) as Record<string, unknown>;
  }

  private async json(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.apiUrl}${path}`;
    let lastError: unknown;

    for (let i = 0; i <= this.connOptions.maxRetry; i++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          body: body == null ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.connOptions.timeoutMs),
        });
        const payload = await readPayload(response);
        if (response.ok) {
          if (!isRecord(payload)) {
            throw new APIStatusError({
              message: 'Protoface API returned a non-object JSON response',
              options: { statusCode: response.status, body: { payload }, retryable: false },
            });
          }
          return payload;
        }

        throw new APIStatusError({
          message: 'Protoface API returned an error',
          options: { statusCode: response.status, body: isRecord(payload) ? payload : { payload } },
        });
      } catch (error) {
        if (error instanceof APIStatusError && !error.retryable) {
          throw error;
        }
        lastError = normalizeConnectionError(error);
      }

      if (i < this.connOptions.maxRetry) {
        this.#logger.warn(
          { attempt: i + 1, method, path },
          'protoface api request failed, retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, intervalForRetry(this.connOptions, i)));
      }
    }

    throw new APIConnectionError({
      message: 'Failed to call Protoface API after all retries.',
      options: { body: isRecord(lastError) ? lastError : null },
    });
  }
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeConnectionError(error: unknown): unknown {
  if (error instanceof APIStatusError) {
    return error;
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new APITimeoutError({ message: 'Protoface API request timed out.' });
  }
  return error;
}
