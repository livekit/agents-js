// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError } from '@livekit/agents';

export const DEFAULT_REGION = 'us-east-1';

/** Explicit static AWS credentials. When omitted, the AWS SDK v3 default credential chain is used. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Resolves the AWS region to use, in order of precedence:
 * the explicit `region` argument, `AWS_REGION`, `AWS_DEFAULT_REGION`, then {@link DEFAULT_REGION}.
 */
export function resolveRegion(region?: string): string {
  return region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? DEFAULT_REGION;
}

/** Removes `undefined`-valued keys so they aren't sent to AWS SDK calls. */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

/** Shape of AWS SDK v3 service exceptions we care about when classifying failures. */
interface AwsSdkErrorLike {
  message?: string;
  Message?: string;
  name?: string;
  $metadata?: {
    httpStatusCode?: number;
    requestId?: string;
  };
}

/**
 * Maps an AWS SDK exception (or already-classified framework error) into an
 * {@link APIStatusError} when an HTTP status is present, otherwise an
 * {@link APIConnectionError}. Passes through existing API errors unchanged.
 */
export function toAwsApiError(
  error: unknown,
  prefix: string,
  options?: { retryable?: boolean; requestId?: string | null },
): APIConnectionError | APIStatusError {
  if (error instanceof APIStatusError || error instanceof APIConnectionError) {
    return error;
  }

  const err = error as AwsSdkErrorLike;
  const message = err.message ?? err.Message ?? String(error);
  const statusCode = err.$metadata?.httpStatusCode;

  if (statusCode !== undefined) {
    return new APIStatusError({
      message: `${prefix}: ${message}`,
      options: {
        statusCode,
        requestId: options?.requestId ?? err.$metadata?.requestId ?? null,
        retryable: options?.retryable,
      },
    });
  }

  return new APIConnectionError({
    message: `${prefix}: ${message}`,
    options: { retryable: options?.retryable },
  });
}
