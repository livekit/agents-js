// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, APITimeoutError } from '@livekit/agents';
import { RealtimeTranscriptionException } from '@mistralai/mistralai/extra/realtime/errors';
import {
  HTTPValidationError,
  RequestTimeoutError,
  SDKError,
} from '@mistralai/mistralai/models/errors';

export function mistralAPIError(
  error: unknown,
  retryable = true,
): APIStatusError | APITimeoutError | undefined {
  if (
    error instanceof RequestTimeoutError ||
    (error instanceof RealtimeTranscriptionException &&
      error.message === 'Timeout waiting for session creation.')
  ) {
    return new APITimeoutError({ message: error.message, options: { retryable } });
  }

  if (error instanceof SDKError || error instanceof HTTPValidationError) {
    return new APIStatusError({
      message: error.message,
      options: {
        statusCode: error.statusCode,
        requestId: error.headers.get('x-request-id'),
        body: error.body,
        retryable,
      },
    });
  }

  return undefined;
}
