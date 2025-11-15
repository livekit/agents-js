// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Base error class for ElevenLabs-specific exceptions
 */
export class ElevenLabsError extends Error {
  public readonly statusCode?: number;
  public readonly body?: unknown;

  constructor({
    message,
    statusCode,
    body,
  }: {
    message?: string;
    statusCode?: number;
    body?: unknown;
  }) {
    super(buildMessage({ message, statusCode, body }));
    Object.setPrototypeOf(this, ElevenLabsError.prototype);
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Error thrown when a request to ElevenLabs times out
 */
export class ElevenLabsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ElevenLabsTimeoutError.prototype);
  }
}

/**
 * Error thrown when WebSocket connection fails
 */
export class ElevenLabsConnectionError extends ElevenLabsError {
  public readonly retries: number;

  constructor({
    message,
    retries,
    statusCode,
    body,
  }: {
    message?: string;
    retries: number;
    statusCode?: number;
    body?: unknown;
  }) {
    super({ message, statusCode, body });
    Object.setPrototypeOf(this, ElevenLabsConnectionError.prototype);
    this.retries = retries;
  }
}

function buildMessage({
  message,
  statusCode,
  body,
}: {
  message: string | undefined;
  statusCode: number | undefined;
  body: unknown | undefined;
}): string {
  const lines: string[] = [];
  if (message != null) {
    lines.push(message);
  }

  if (statusCode != null) {
    lines.push(`Status code: ${statusCode.toString()}`);
  }

  if (body != null) {
    lines.push(`Body: ${JSON.stringify(body, undefined, 2)}`);
  }

  return lines.join('\n');
}
