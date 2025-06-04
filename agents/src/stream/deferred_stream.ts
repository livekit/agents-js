// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type ReadableStream } from 'node:stream/web';
import { IdentityTransform } from './identity_transform.js';

export class DeferredReadableStream<T> {
  private transform: IdentityTransform<T>;

  get stream() {
    return this.transform.readable;
  }

  constructor() {
    this.transform = new IdentityTransform<T>();
  }

  /**
   * Call once the actual source is ready.
   */
  setSource(source: ReadableStream<T>) {
    if (this.transform.writable.locked) {
      throw new Error('Stream source already set');
    }
    return source.pipeTo(this.transform.writable);
  }
}
