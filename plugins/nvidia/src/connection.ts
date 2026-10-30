// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import type { RivaClientConstructor } from './proto.js';

interface ConnectionOptions {
  apiKey?: string;
  functionId: string;
  server: string;
  useSsl: boolean;
}

/** Owns one lazy gRPC channel and the metadata shared by its calls. */
export class RivaConnection<T extends grpc.Client> {
  readonly metadata = new grpc.Metadata();
  #client?: T;

  constructor(
    private readonly options: ConnectionOptions,
    private readonly Client: RivaClientConstructor<T>,
  ) {
    if (options.useSsl && !options.apiKey) {
      throw new Error(
        'NVIDIA API key is required when using SSL. Pass apiKey, set NVIDIA_API_KEY, or disable SSL for a locally hosted Riva NIM service.',
      );
    }
    if (options.useSsl) {
      if (options.apiKey) this.metadata.set('authorization', `Bearer ${options.apiKey}`);
      this.metadata.set('function-id', options.functionId);
    }
  }

  get client(): T {
    return (this.#client ??= new this.Client(
      this.options.server,
      this.options.useSsl ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    ));
  }

  close(): void {
    this.#client?.close();
    this.#client = undefined;
  }
}
