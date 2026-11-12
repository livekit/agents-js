// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import {
  APIConnectionError,
  type APIError,
  APIStatusError,
  APITimeoutError,
  ConnectionPool,
} from '@livekit/agents';
import type { RivaClientConstructor } from './proto.js';

const STATUS_CODES: Partial<Record<grpc.status, number>> = {
  [grpc.status.INVALID_ARGUMENT]: 400,
  [grpc.status.NOT_FOUND]: 404,
  [grpc.status.ALREADY_EXISTS]: 409,
  [grpc.status.PERMISSION_DENIED]: 403,
  [grpc.status.RESOURCE_EXHAUSTED]: 429,
  [grpc.status.FAILED_PRECONDITION]: 400,
  [grpc.status.ABORTED]: 503,
  [grpc.status.OUT_OF_RANGE]: 400,
  [grpc.status.UNIMPLEMENTED]: 501,
  [grpc.status.INTERNAL]: 500,
  [grpc.status.UNAVAILABLE]: 503,
  [grpc.status.DATA_LOSS]: 500,
  [grpc.status.UNAUTHENTICATED]: 401,
};

const RETRYABLE_STATUSES: ReadonlySet<grpc.status> = new Set([
  grpc.status.UNKNOWN,
  grpc.status.RESOURCE_EXHAUSTED,
  grpc.status.ABORTED,
  grpc.status.INTERNAL,
  grpc.status.UNAVAILABLE,
]);

/** Convert a failed NVIDIA Speech call into the matching LiveKit API error. */
export function toAPIError(error: grpc.ServiceError, message: string): APIError {
  const details = error.details || error.message;
  if (error.code === grpc.status.DEADLINE_EXCEEDED) {
    return new APITimeoutError({ message: `${message} timed out: ${details}` });
  }
  if (error.code === grpc.status.CANCELLED) {
    return new APIConnectionError({ message: `${message} was cancelled by NVIDIA Speech` });
  }
  return new APIStatusError({
    message: `${message}: ${details}`,
    options: {
      statusCode: STATUS_CODES[error.code] ?? -1,
      retryable: RETRYABLE_STATUSES.has(error.code),
    },
  });
}

/** Endpoint and authentication settings shared by the Riva services. */
interface ConnectionOptions {
  apiKey?: string;
  functionId: string;
  server: string;
  useSsl: boolean;
}

/** Creates authenticated Riva clients and delegates their lifetime to the framework pool. */
export class RivaConnection<T extends grpc.Client> {
  readonly metadata = new grpc.Metadata();
  readonly pool: ConnectionPool<T>;

  constructor(options: ConnectionOptions, Client: RivaClientConstructor<T>) {
    if (options.useSsl && !options.apiKey) {
      throw new Error(
        'NVIDIA API key is required when using SSL. Pass apiKey, set NVIDIA_API_KEY, or disable SSL for a locally hosted Riva NIM service.',
      );
    }
    if (options.useSsl) {
      if (options.apiKey) this.metadata.set('authorization', `Bearer ${options.apiKey}`);
      this.metadata.set('function-id', options.functionId);
    }
    const credentials = options.useSsl
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    this.pool = new ConnectionPool({
      connectCb: async () => new Client(options.server, credentials),
      closeCb: async (client) => client.close(),
    });
  }
}
