// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '@livekit/agents';
import { ErrorType, SynthesiaError } from './errors.js';
import { log } from './log.js';
import type { StartSessionRequest, StartSessionResponse } from './types.js';

/** @internal */
export const SESSION_PATH = '/api/interactive-avatars/sessions';
const AVATAR_ID_PREFIX = 'av_';

const CODE_TO_ERROR: Record<string, ErrorType> = {
  unauthorized: ErrorType.AUTH,
  invalid_api_key: ErrorType.AUTH,
  unknown_avatar: ErrorType.UNKNOWN_AVATAR,
  avatar_not_accessible: ErrorType.UNKNOWN_AVATAR,
  quota_exceeded: ErrorType.QUOTA_EXCEEDED,
  rate_limited: ErrorType.RATE_LIMITED,
  invalid_token: ErrorType.INVALID_ROOM_TOKEN,
  invalid_livekit_credentials: ErrorType.LIVEKIT_CREDENTIALS_REJECTED,
  validation_error: ErrorType.INVALID_SESSION_REQUEST,
  bad_request: ErrorType.INVALID_SESSION_REQUEST,
  unknown_reference: ErrorType.UNKNOWN_AVATAR,
  unauthenticated: ErrorType.AUTH,
  forbidden: ErrorType.AUTH,
  insufficient_scope: ErrorType.AUTH,
  not_authorized: ErrorType.AUTH,
  feature_not_in_plan: ErrorType.FEATURE_NOT_IN_PLAN,
  payment_required: ErrorType.QUOTA_EXCEEDED,
  concurrency_limit: ErrorType.CONCURRENCY_LIMIT,
  concurrency_limit_exceeded: ErrorType.CONCURRENCY_LIMIT,
};

const STATUS_TO_ERROR: Record<number, ErrorType> = {
  401: ErrorType.AUTH,
  403: ErrorType.AUTH,
  402: ErrorType.QUOTA_EXCEEDED,
  404: ErrorType.UNKNOWN_AVATAR,
  429: ErrorType.RATE_LIMITED,
};

/** @internal */
export interface SynthesiaAPIOptions {
  apiKey: string;
  apiUrl: string;
  connOptions?: APIConnectOptions;
  fetch?: typeof globalThis.fetch;
}

/** Async client for the Synthesia interactive-avatar session API. @internal */
export class SynthesiaAPI {
  #apiKey: string;
  private apiUrl: string;
  private connOptions: APIConnectOptions;
  private fetch: typeof globalThis.fetch;

  constructor(options: SynthesiaAPIOptions) {
    this.#apiKey = options.apiKey;
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.connOptions = options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async startSession(
    request: StartSessionRequest,
    connOptions: APIConnectOptions = this.connOptions,
  ): Promise<StartSessionResponse> {
    const url = this.apiUrl + SESSION_PATH;
    const payload = {
      avatarIds: request.avatarIds.map(publicAvatarId),
      livekitUrl: request.livekitUrl,
      livekitToken: request.livekitToken,
    };

    let lastStatus: number | null = null;
    let lastBody: unknown = null;
    let lastCause: unknown;

    for (let attempt = 0; attempt <= connOptions.maxRetry; attempt++) {
      let status: number | null = null;
      try {
        const response = await this.fetch(url, {
          method: 'POST',
          headers: { Authorization: this.#apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(connOptions.timeoutMs),
        });
        status = response.status;
        const body = await readJson(response);
        if (response.ok) return parseSuccess(body);
        if (status < 500) throw mappedError(response, body);
        lastStatus = status;
        lastBody = body;
        lastCause = undefined;
        log().debug({ status }, 'synthesia session request failed, retrying');
      } catch (error) {
        if (error instanceof SynthesiaError) throw error;
        lastStatus = status !== null && status >= 500 ? status : null;
        lastBody = null;
        lastCause = error;
        log().debug({ error: errorName(error) }, 'synthesia session request errored, retrying');
      }

      if (attempt < connOptions.maxRetry) {
        await new Promise((resolve) => setTimeout(resolve, connOptions.retryIntervalMs));
      }
    }

    throw new SynthesiaError(exhaustedMessage(connOptions.maxRetry + 1, lastStatus, lastBody), {
      type: ErrorType.CONNECTION,
      body: isRecord(lastBody) ? lastBody : null,
      status: lastStatus,
      requestId: bodyRequestId(lastBody),
      cause: lastCause,
    });
  }
}

function parseSuccess(body: unknown): StartSessionResponse {
  if (isRecord(body)) {
    const sessionId = body.id || body.session_id;
    if (typeof sessionId === 'string' && sessionId) return { sessionId };
  }
  throw new SynthesiaError('Synthesia response did not contain a session id');
}

function mappedError(response: Response, body: unknown): SynthesiaError {
  const code = bodyCode(body);
  let errorType = code ? CODE_TO_ERROR[code] : undefined;
  if (errorType === undefined && !(isProblem(body) && code !== null)) {
    errorType = STATUS_TO_ERROR[response.status];
  }
  const message =
    bodyMessage(body) ?? `Synthesia request failed (${code ?? `HTTP ${response.status}`})`;
  const retryAfter =
    errorType === ErrorType.RATE_LIMITED || errorType === ErrorType.CONCURRENCY_LIMIT
      ? parseRetryAfter(response, body)
      : null;
  return new SynthesiaError(message, {
    type: errorType,
    retryAfter,
    body: isRecord(body) ? body : null,
    status: response.status,
    requestId: bodyRequestId(body),
  });
}

function exhaustedMessage(attempts: number, status: number | null, body: unknown): string {
  let message = 'could not start a Synthesia session';
  if (attempts > 1) message += ` after ${attempts} attempts`;
  if (status === null) return `${message}; last attempt: connection error`;
  message += `; last attempt: HTTP ${status}`;
  const detail = bodyMessage(body);
  if (detail !== null) message += `: ${detail}`;
  const requestId = bodyRequestId(body);
  if (requestId !== null) message += ` (request ${requestId})`;
  return message;
}

function isProblem(body: unknown): boolean {
  return isRecord(body) && typeof body.type === 'string';
}

function bodyCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const nested = isRecord(body.error) ? body.error.code : undefined;
  const code = nested || body.code;
  return typeof code === 'string' ? code : null;
}

function bodyMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (isProblem(body)) {
    if (typeof body.detail === 'string' && body.detail) return body.detail;
    return typeof body.title === 'string' && body.title ? body.title : null;
  }
  const nested = isRecord(body.error) ? body.error.message : undefined;
  const detail = nested || body.message || body.context;
  if (detail === undefined || detail === null) {
    return typeof body.error === 'string' ? body.error : null;
  }
  if (typeof detail === 'string') return detail;
  const rendered = JSON.stringify(detail);
  const code = bodyCode(body);
  return code ? `${code}: ${rendered}` : rendered;
}

function bodyRequestId(body: unknown): string | null {
  return isRecord(body) && typeof body.requestId === 'string' ? body.requestId : null;
}

function publicAvatarId(avatarId: string): string {
  return avatarId.startsWith(AVATAR_ID_PREFIX) ? avatarId : AVATAR_ID_PREFIX + avatarId;
}

function parseRetryAfter(response: Response, body: unknown): number | null {
  const header = response.headers.get('Retry-After');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  if (isRecord(body)) {
    const nested = isRecord(body.error) ? body.error.retry_after : undefined;
    for (const value of [body.retry_after, nested]) {
      if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
    }
  }
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorName(value: unknown): string {
  return value instanceof Error ? value.name : typeof value;
}
