// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import { ConnectionPool } from '@livekit/agents';
import type { RivaClientConstructor } from './proto.js';

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
