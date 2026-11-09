// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError } from '@livekit/agents';

/** What went wrong, for callers that want to branch on it. @public */
export enum ErrorType {
  AUTH = 'auth',
  FEATURE_NOT_IN_PLAN = 'feature_not_in_plan',
  INVALID_ROOM_TOKEN = 'invalid_room_token',
  LIVEKIT_CREDENTIALS_REJECTED = 'livekit_credentials_rejected',
  INVALID_SESSION_REQUEST = 'invalid_session_request',
  UNKNOWN_AVATAR = 'unknown_avatar',
  QUOTA_EXCEEDED = 'quota_exceeded',
  RATE_LIMITED = 'rate_limited',
  CONCURRENCY_LIMIT = 'concurrency_limit',
  TIMEOUT = 'timeout',
  CONNECTION = 'connection',
}

const RETRYABLE_TYPES = new Set([
  ErrorType.RATE_LIMITED,
  ErrorType.CONCURRENCY_LIMIT,
  ErrorType.TIMEOUT,
  ErrorType.CONNECTION,
]);

/** @public */
export interface SynthesiaErrorOptions {
  type?: ErrorType | null;
  body?: object | null;
  retryable?: boolean;
  /** Server-provided backoff in milliseconds. */
  retryAfter?: number | null;
  status?: number | null;
  requestId?: string | null;
  cause?: unknown;
}

/** Every error raised by the Synthesia plugin. @public */
export class SynthesiaError extends APIError {
  readonly type: ErrorType | null;
  readonly retryAfter: number | null;
  readonly status: number | null;
  readonly requestId: string | null;

  constructor(message: unknown, options: SynthesiaErrorOptions = {}) {
    const type = options.type ?? null;
    super(stringify(message), {
      body: options.body,
      retryable: options.retryable ?? RETRYABLE_TYPES.has(type as ErrorType),
    });
    this.name = 'SynthesiaError';
    this.type = type;
    this.retryAfter = options.retryAfter ?? null;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace(this, SynthesiaError);
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
