// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { IdentityTransform } from './identity_transform.js';

export interface StreamChannel<T> {
  write(chunk: T): Promise<void>;
  close(): Promise<void>;
  stream(): ReadableStream<T>;
}

export function createStreamChannel<T>(): StreamChannel<T> {
  const transform = new IdentityTransform<T>();
  const writer = transform.writable.getWriter();

  return {
    write: (chunk: T) => writer.write(chunk),
    stream: () => transform.readable,
    close: () => writer.close(),
  };
}
