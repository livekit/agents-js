/**
 * Raised when accepting a job but not receiving an assignment within the specified timeout.
 * The server may have chosen another worker to handle this job.
 */
export class AssignmentTimeoutError extends Error {
  constructor(message = 'Assignment timeout occurred') {
    super(message);
    this.name = 'AssignmentTimeoutError';
  }
}

/**
 * Interface for API error options
 */
interface APIErrorOptions {
  body?: object | null;
  retryable?: boolean;
}

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

  constructor(
    message: string,
    { statusCode = -1, requestId = null, body = null, retryable }: APIStatusErrorOptions = {},
  ) {
    // 4xx errors are not retryable
    const isRetryable = retryable ?? !(statusCode >= 400 && statusCode < 500);

    super(message, { body, retryable: isRetryable });
    this.name = 'APIStatusError';

    this.statusCode = statusCode;
    this.requestId = requestId;
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
 * Interface for API connection error options
 */
interface APIConnectionErrorOptions {
  retryable?: boolean;
}

/**
 * Raised when an API request failed due to a connection error.
 */
export class APIConnectionError extends APIError {
  constructor(message = 'Connection error.', { retryable = true }: APIConnectionErrorOptions = {}) {
    super(message, { body: null, retryable });
    this.name = 'APIConnectionError';
  }
}

/**
 * Raised when an API request timed out.
 */
export class APITimeoutError extends APIConnectionError {
  constructor(
    message = 'Request timed out.',
    { retryable = true }: APIConnectionErrorOptions = {},
  ) {
    super(message, { retryable });
    this.name = 'APITimeoutError';
  }
}

export function assertError(error: unknown): asserts error is Error {
  if (!(error instanceof Error)) {
    throw new Error(`Expected error, got ${error}`);
  }
}
