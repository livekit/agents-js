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
import { randomUUID } from 'node:crypto';
import { BosonAvatarException } from './errors.js';
import { log } from './log.js';

const USER_AGENT = `@livekit/agents-plugin-boson-avatar/${__PACKAGE_VERSION__}`;
const SESSION_OBJECT = 'avatar.livekit.session';

/** Hosted Boson Avatar session returned by the provider API. @public */
export interface AvatarSessionInfo {
  id: string;
  avatarIdentity: string;
}

/** Session creation failed after the provider allocated a session. @public */
export class AvatarSessionStartError extends BosonAvatarException {
  readonly sessionInfo: AvatarSessionInfo;

  constructor(message: string, sessionInfo: AvatarSessionInfo) {
    super(message);
    this.name = 'AvatarSessionStartError';
    this.sessionInfo = sessionInfo;
  }
}

/** Avatar that the authenticated Boson project may render. @public */
export interface AvatarInfo {
  avatarId: string;
  name: string;
}

/** @public */
export interface BosonAvatarAPIOptions {
  apiKey?: string | null;
  apiUrl?: string | null;
  connOptions?: APIConnectOptions;
}

/** @public */
export interface StartSessionOptions {
  avatarId: string;
  livekitUrl: string;
  livekitRoom: string;
  livekitToken: string;
  avatarIdentity: string;
  publisherIdentity: string;
  width?: number | null;
  height?: number | null;
  maxDurationMs?: number | null;
  idempotencyKey?: string | null;
}

/** Async client for the hosted Boson LiveKit Avatar API. @public */
export class BosonAvatarAPI {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly connOptions: APIConnectOptions;
  #logger = log();

  constructor(options: BosonAvatarAPIOptions = {}) {
    this.apiKey = resolveApiKey(options.apiKey);
    if (!this.apiKey) {
      throw new BosonAvatarException(
        'apiKey must be set by passing it to AvatarSession or setting the BOSON_API_KEY environment variable',
      );
    }
    const apiUrl = resolveString(options.apiUrl, 'BOSON_AVATAR_API_URL');
    if (!apiUrl) {
      throw new BosonAvatarException(
        'apiUrl must be set by passing it to AvatarSession or setting the BOSON_AVATAR_API_URL environment variable',
      );
    }
    this.apiUrl = validateApiUrl(apiUrl);
    this.connOptions = options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
  }

  async listAvatars(): Promise<AvatarInfo[]> {
    const { payload } = await this.json('GET', '/avatars', { successStatuses: new Set([200]) });
    if (payload.object !== 'avatar.list' || !Array.isArray(payload.data)) {
      throw new BosonAvatarException('Boson Avatar API returned an invalid Avatar list');
    }
    const seen = new Set<string>();
    return payload.data.map((value) => {
      if (
        !isRecord(value) ||
        typeof value.avatar_id !== 'string' ||
        typeof value.name !== 'string'
      ) {
        throw new BosonAvatarException('Boson Avatar API returned an invalid Avatar list');
      }
      const avatarId = value.avatar_id.trim();
      const name = value.name.trim();
      if (!avatarId || !name || seen.has(avatarId)) {
        throw new BosonAvatarException('Boson Avatar API returned an invalid Avatar list');
      }
      seen.add(avatarId);
      return { avatarId, name };
    });
  }

  async startSession(options: StartSessionOptions): Promise<AvatarSessionInfo> {
    const body: Record<string, unknown> = {
      avatar_id: options.avatarId,
      transport: {
        type: 'livekit',
        url: options.livekitUrl,
        room_name: options.livekitRoom,
        participant_token: options.livekitToken,
        participant_identity: options.avatarIdentity,
        publisher_identity: options.publisherIdentity,
        audio_source: 'data_stream',
      },
    };
    if (options.width != null && options.height != null) {
      body.output = { width: options.width, height: options.height };
    }
    if (options.maxDurationMs != null) body.max_duration_seconds = options.maxDurationMs / 1000;

    const { payload } = await this.json('POST', '/sessions', {
      body,
      headers: { 'Idempotency-Key': options.idempotencyKey ?? randomUUID() },
      successStatuses: new Set([200, 201]),
    });
    const sessionId = payload.id;
    const returnedIdentity = payload.avatar_identity;
    const valid =
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      payload.object === SESSION_OBJECT &&
      payload.status === 'active' &&
      returnedIdentity === options.avatarIdentity;
    if (valid) return { id: sessionId, avatarIdentity: returnedIdentity as string };
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new BosonAvatarException('Boson Avatar API response is missing a session id');
    }
    const message =
      returnedIdentity !== options.avatarIdentity
        ? 'Boson Avatar API returned a participant identity that does not match the request'
        : 'Boson Avatar API returned an invalid active session';
    const sessionInfo = {
      id: sessionId,
      avatarIdentity:
        typeof returnedIdentity === 'string' ? returnedIdentity : options.avatarIdentity,
    };
    try {
      await this.endSession(sessionId);
    } catch (error) {
      this.#logger.warn(
        { errorType: errorName(error), 'lk.pii.session_id': sessionId },
        'failed to compensate boson avatar session after invalid response',
      );
      throw new AvatarSessionStartError(message, sessionInfo);
    }
    throw new BosonAvatarException(message);
  }

  async endSession(sessionId: string): Promise<void> {
    const { status, payload } = await this.json(
      'DELETE',
      `/sessions/${encodeURIComponent(sessionId)}`,
      {
        allowEmpty: true,
        successStatuses: new Set([200, 204]),
      },
    );
    const invalid =
      (status === 204 && Object.keys(payload).length > 0) ||
      (status === 200 &&
        (payload.id !== sessionId ||
          payload.object !== SESSION_OBJECT ||
          payload.status !== 'terminated'));
    if (invalid) {
      throw new BosonAvatarException('Boson Avatar API returned an invalid terminated session');
    }
  }

  private async json(
    method: string,
    path: string,
    options: {
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
      allowEmpty?: boolean;
      successStatuses: Set<number>;
    },
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const headers = {
      authorization: `Bearer ${this.apiKey}`,
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    };
    for (let attempt = 0; attempt <= this.connOptions.maxRetry; attempt++) {
      let retryAfterMs: number | null = null;
      let errorType = 'client_error';
      try {
        const response = await fetch(`${this.apiUrl}${path}`, {
          method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(this.connOptions.timeoutMs),
        });
        const rawPayload = await readPayload(response);
        if (options.successStatuses.has(response.status)) {
          if (rawPayload === null && options.allowEmpty && response.status === 204) {
            return { status: response.status, payload: {} };
          }
          if (!isRecord(rawPayload)) {
            throw new APIStatusError({
              message: 'Boson Avatar API returned a non-object JSON response',
              options: {
                statusCode: response.status,
                body: wrapPayload(rawPayload),
                retryable: false,
              },
            });
          }
          return { status: response.status, payload: rawPayload };
        }
        let requestId = response.headers.get('x-request-id');
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        if (isRecord(rawPayload) && isRecord(rawPayload.error)) {
          const nested = rawPayload.error.request_id;
          if (nested != null) requestId = String(nested) || requestId;
        }
        throw new APIStatusError({
          message: 'Boson Avatar API returned an error',
          options: {
            statusCode: response.status,
            requestId,
            body: wrapPayload(rawPayload),
            retryable: !(response.status >= 200 && response.status < 400),
          },
        });
      } catch (error) {
        if (error instanceof APIStatusError) {
          if (!error.retryable) throw error;
          errorType = error.name;
        } else if (error instanceof DOMException && error.name === 'TimeoutError') {
          errorType = 'timeout';
        }
      }
      if (attempt === this.connOptions.maxRetry) break;
      this.#logger.warn(
        { attempt: attempt + 1, errorType, method, 'lk.pii.path': path },
        'boson avatar api request failed, retrying',
      );
      const delay = Math.max(intervalForRetry(this.connOptions, attempt), retryAfterMs ?? 0);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new APIConnectionError({ message: 'Failed to call Boson Avatar API after all retries.' });
  }
}

/** List project Avatars using the configured provider endpoint. @public */
export async function listAvatars(options: BosonAvatarAPIOptions = {}): Promise<AvatarInfo[]> {
  return new BosonAvatarAPI(options).listAvatars();
}

async function readPayload(response: Response): Promise<unknown | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function resolveApiKey(value?: string | null): string {
  return (value || process.env.BOSON_API_KEY || process.env.BOSONAI_API_KEY || '').trim();
}

function resolveString(value: string | null | undefined, envName: string): string {
  return (value || process.env[envName] || '').trim();
}

function validateApiUrl(value: string): string {
  const normalized = value.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/i.test(normalized)) {
    throw new BosonAvatarException('apiUrl must be a valid absolute HTTP(S) base URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new BosonAvatarException('apiUrl must be a valid absolute HTTP(S) base URL');
  }
  if (
    !normalized ||
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    /\s/.test(normalized)
  ) {
    throw new BosonAvatarException(
      'apiUrl must be an absolute HTTP(S) base URL without credentials, query, or fragment',
    );
  }
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new BosonAvatarException(
      'apiUrl must use HTTPS unless it targets a loopback host; the API key is sent as a Bearer credential',
    );
  }
  return normalized;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets.every(Number.isInteger) && octets[0] === 127;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function wrapPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { payload: value };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
