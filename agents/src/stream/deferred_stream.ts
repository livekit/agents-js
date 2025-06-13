// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  ReadableStream,
  ReadableStreamDefaultReader,
  WritableStreamDefaultWriter,
} from 'node:stream/web';
import { IdentityTransform } from './identity_transform.js';

/**
 * Check if error is related to reader.read after release lock
 *
 * Invalid state: Releasing reader
 * Invalid state: The reader is not attached to a stream
 */
export function isStreamReaderReleaseError(e: unknown) {
  const allowedMessages = [
    'Invalid state: Releasing reader',
    'Invalid state: The reader is not attached to a stream',
  ];

  if (e instanceof TypeError) {
    return allowedMessages.some((message) => e.message.includes(message));
  }

  return false;
}
export class DeferredReadableStream<T> {
  private transform: IdentityTransform<T>;
  private writer: WritableStreamDefaultWriter<T>;
  private sourceReader?: ReadableStreamDefaultReader<T>;

  constructor() {
    this.transform = new IdentityTransform<T>();
    this.writer = this.transform.writable.getWriter();
  }

  get stream() {
    return this.transform.readable;
  }

  get isSourceSet() {
    return !!this.sourceReader;
  }

  /**
   * Call once the actual source is ready.
   */
  setSource(source: ReadableStream<T>) {
    if (this.isSourceSet) {
      throw new Error('Stream source already set');
    }

    this.sourceReader = source.getReader();
    this.pump();
  }

  private async pump() {
    let sourceError: unknown;

    try {
      while (true) {
        const { done, value } = await this.sourceReader!.read();
        if (done) break;
        await this.writer.write(value);
      }
    } catch (e) {
      // skip source detach related errors
      if (isStreamReaderReleaseError(e)) return;
      sourceError = e;
    } finally {
      // any other error from source will be propagated to the consumer
      if (sourceError) {
        this.writer.abort(sourceError);
        return;
      }

      // release lock so this.stream.getReader().read() will terminate with done: true
      this.writer.releaseLock();

      // we only close the writable stream after done
      try {
        await this.transform.writable.close();
        // NOTE: we do not cancel this.transform.readable as there might be access to
        // this.transform.readable.getReader() outside that blocks this cancellation
        // hence, user is responsible for canceling reader on their own
      } catch (e) {
        // ignore TypeError: Invalid state: WritableStream is closed
        // in case stream reader is already closed, this will throw
        // but we ignore it as we are closing the stream anyway
      }
    }
  }

  /**
   * Detach the source stream and clean up resources.
   */
  async detachSource() {
    if (!this.isSourceSet) {
      throw new Error('Source not set');
    }

    // release lock will make any pending read() throw TypeError
    // which are expected, and we intentionally catch those error
    // using isStreamReaderReleaseError
    // this will unblock any pending read() inside the async for loop
    this.sourceReader!.releaseLock();
  }
}
