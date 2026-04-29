// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
} from '@livekit/agents';
import { log } from './log.js';

export const DEFAULT_API_URL = 'https://api.liveavatar.com/v1/sessions';

export type VideoQuality = 'very_high' | 'high' | 'medium' | 'low';

/**
 * Exception thrown when the LiveAvatar plugin or the LiveAvatar service errors.
 */
export class LiveAvatarException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveAvatarException';
  }
}

export interface CreateStreamingSessionOptions {
  livekitUrl: string;
  livekitToken: string;
  roomName: string;
  avatarId: string;
  isSandbox?: boolean;
  videoQuality?: VideoQuality | null;
}

export interface SessionResponse {
  data: {
    session_id: string;
    session_token: string;
    [key: string]: unknown;
  };
  code: number;
  [key: string]: unknown;
}

export interface StartSessionResponse {
  data: {
    ws_url: string;
    [key: string]: unknown;
  };
  code: number;
  [key: string]: unknown;
}

export interface StopSessionResponse {
  data: Record<string, unknown>;
  code: number;
  [key: string]: unknown;
}

export interface LiveAvatarAPIOptions {
  apiKey?: string;
  apiUrl?: string;
  connOptions?: APIConnectOptions;
}

/**
 * Thin client for the LiveAvatar HTTP API.
 *
 * Mirrors `livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/api.py`.
 */
export class LiveAvatarAPI {
  private apiKey: string;
  private apiUrl: string;
  private connOptions: APIConnectOptions;

  #logger = log();

  constructor(options: LiveAvatarAPIOptions = {}) {
    const apiKey = options.apiKey ?? process.env.LIVEAVATAR_API_KEY ?? '';
    if (!apiKey) {
      throw new LiveAvatarException('api_key or LIVEAVATAR_API_KEY must be set');
    }
    this.apiKey = apiKey;
    this.apiUrl = options.apiUrl || DEFAULT_API_URL;
    this.connOptions = options.connOptions || DEFAULT_API_CONNECT_OPTIONS;
  }

  /**
   * Create a new streaming session, returning the session id and session token.
   *
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/api.py - 51-87 lines
   */
  async createStreamingSession(opts: CreateStreamingSessionOptions): Promise<SessionResponse> {
    const livekitConfig = {
      livekit_room: opts.roomName,
      livekit_url: opts.livekitUrl,
      livekit_client_token: opts.livekitToken,
    };

    const payload: Record<string, unknown> = {
      mode: 'LITE',
      avatar_id: opts.avatarId,
      is_sandbox: opts.isSandbox ?? false,
      livekit_config: livekitConfig,
    };

    if (opts.videoQuality != null) {
      payload.video_quality = opts.videoQuality;
    }

    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'X-API-KEY': this.apiKey,
    };
    return (await this.post('/token', payload, headers)) as SessionResponse;
  }

  /**
   * Start a previously created streaming session.
   *
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/api.py - 92-97 lines
   */
  async startStreamingSession(
    sessionId: string,
    sessionToken: string,
  ): Promise<StartSessionResponse> {
    const payload = { session_id: sessionId };
    const headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    };
    return (await this.post('/start', payload, headers)) as StartSessionResponse;
  }

  /**
   * Stop a running streaming session.
   *
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/api.py - 99-107 lines
   */
  async stopStreamingSession(
    sessionId: string,
    sessionToken: string,
  ): Promise<StopSessionResponse> {
    const payload = { session_id: sessionId, reason: 'USER_DISCONNECTED' };
    const headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    };
    return (await this.post('/stop', payload, headers)) as StopSessionResponse;
  }

  /**
   * POST helper with the same retry/backoff semantics as the Python plugin.
   *
   * Ref: python livekit-plugins/livekit-plugins-liveavatar/livekit/plugins/liveavatar/api.py - 109-138 lines
   */
  private async post(
    endpoint: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const url = this.apiUrl + endpoint;
    const maxRetry = this.connOptions.maxRetry;
    // `maxRetry` is the number of retries on top of the initial attempt, so we
    // run up to `maxRetry + 1` total attempts. This matches the convention used
    // by other agents-js plugins (e.g. lemonslice/runway) and ensures a single
    // attempt still fires when callers configure `maxRetry: 0`.
    for (let i = 0; i <= maxRetry; i++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.connOptions.timeoutMs),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new APIStatusError({
            message: `Server returned an error for ${url}: ${response.status}`,
            options: { statusCode: response.status, body: { error: text } },
          });
        }
        return await response.json();
      } catch (e) {
        if (e instanceof APIStatusError && !e.retryable) {
          throw e;
        }
        this.#logger.warn(
          { error: String(e), url, attempt: i },
          `API request to ${url} failed on attempt ${i}`,
        );
      }

      if (i < maxRetry) {
        await new Promise((resolve) => setTimeout(resolve, this.connOptions.retryIntervalMs));
      }
    }
    throw new APIConnectionError({
      message: `Failed to call LiveAvatar API after ${maxRetry + 1} attempts`,
    });
  }
}
