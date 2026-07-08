// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

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
