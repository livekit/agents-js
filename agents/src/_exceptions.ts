// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Raised when accepting a job but not receiving an assignment within the specified timeout.
 * The server may have chosen another worker to handle this job.
 */
export class AssignmentTimeoutError extends Error {
  constructor(message = 'Assignment timeout occurred') {
    super(message);
    this.name = 'AssignmentTimeoutError';
    Error.captureStackTrace(this, AssignmentTimeoutError);
  }
}

/**
 * Interface for API error options
 */
interface APIErrorOptions {
  body?: object | null;
  retryable?: boolean;
}

const API_ERROR_SYMBOL = Symbol('APIError');

/**
 * Raised when an API request failed.
 * This is used on our TTS/STT/LLM plugins.
 */
export class APIError extends Error {
  readonly body: object | null;
  readonly retryable: boolean;

  constructor(message: string, { body = null, retryable = true }: APIErrorOptions = {}) {
    super(message);
    this.name = 'APIError';

    this.body = body;
    this.retryable = retryable;
    Error.captureStackTrace(this, APIError);
    Object.defineProperty(this, API_ERROR_SYMBOL, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  toString(): string {
    return `${this.message} (body=${JSON.stringify(this.body)}, retryable=${this.retryable})`;
  }
}

/**
 * Interface for API status error options
 */
interface APIStatusErrorOptions extends APIErrorOptions {
  statusCode?: number;
  requestId?: string | null;
}

/**
 * Raised when an API response has a status code of 4xx or 5xx.
 */
export class APIStatusError extends APIError {
  readonly statusCode: number;
  readonly requestId: string | null;

  constructor({
    message = 'API error.',
    options = {},
  }: {
    message?: string;
    options?: APIStatusErrorOptions;
  }) {
    const statusCode = options.statusCode ?? -1;
    // 4xx errors are not retryable
    const isRetryable = options.retryable ?? !(statusCode >= 400 && statusCode < 500);

    super(message, { body: options.body, retryable: isRetryable });
    this.name = 'APIStatusError';

    this.statusCode = statusCode;
    this.requestId = options.requestId ?? null;
    Error.captureStackTrace(this, APIStatusError);
  }

  toString(): string {
    return (
      `${this.message} ` +
      `(statusCode=${this.statusCode}, ` +
      `requestId=${this.requestId}, ` +
      `body=${JSON.stringify(this.body)}, ` +
      `retryable=${this.retryable})`
    );
  }
}

/**
 * Raised when an API request failed due to a connection error.
 */
export class APIConnectionError extends APIError {
  constructor({
    message = 'Connection error.',
    options = {},
  }: {
    message?: string;
    options?: APIErrorOptions;
  }) {
    super(message, { body: null, retryable: options.retryable ?? true });
    this.name = 'APIConnectionError';
    Error.captureStackTrace(this, APIConnectionError);
  }
}

/**
 * Raised when an API request timed out.
 */
export class APITimeoutError extends APIConnectionError {
  constructor({
    message = 'Request timed out.',
    options = {},
  }: {
    message?: string;
    options?: APIErrorOptions;
  }) {
    const retryable = options?.retryable ?? true;

    super({ message, options: { retryable } });
    this.name = 'APITimeoutError';
    Error.captureStackTrace(this, APITimeoutError);
  }
}

export function isAPIError(error: unknown): error is APIError {
  return error !== null && typeof error === 'object' && API_ERROR_SYMBOL in error;
}
