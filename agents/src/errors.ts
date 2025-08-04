// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
const API_ERROR_SYMBOL = Symbol('APIError');

export interface APIErrorOptions {
  body?: object;
  retryable?: boolean;
}

export class APIError extends Error {
  message: string;
  body?: object;
  retryable: boolean;

  constructor(message: string, options?: APIErrorOptions) {
    super(message);

    const { body, retryable = true } = options ?? {};
    this.message = message;
    this.body = body;
    this.retryable = retryable;

    Object.defineProperty(this, API_ERROR_SYMBOL, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

export class APIConnectionError extends APIError {
  constructor(message: string = 'Connection error.', options?: APIErrorOptions) {
    super(message, options);
  }
}

export function isAPIError(error: unknown): error is APIError {
  return error !== null && typeof error === 'object' && API_ERROR_SYMBOL in error;
}
