// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Return a fixed error classification that cannot contain exception text. */
export function safeErrorType(error: unknown): string {
  if (error instanceof AggregateError) return 'AggregateError';
  if (error instanceof EvalError) return 'EvalError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof ReferenceError) return 'ReferenceError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof URIError) return 'URIError';
  return error instanceof Error ? 'Error' : typeof error;
}
