export interface APIErrorOptions {
  body?: object;
  retryable?: boolean;
}

export class APIError extends Error {
  message: string;
  body?: object;
  retryable: boolean;

  constructor(message: string, options: APIErrorOptions) {
    super(message);

    const { body, retryable = true } = options;
    this.message = message;
    this.body = body;
    this.retryable = retryable;
  }
}

export class APIConnectionError extends APIError {
  constructor(message: string = 'Connection error.', options: APIErrorOptions) {
    super(message, options);
  }
}
