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
 * Check if error is related to stream cleanup operations.
 *
 * These errors are expected when calling reader.read() after releaseLock()
 * or when writing to already closed streams during cleanup:
 *
 * Invalid state: Releasing reader
 * Invalid state: The reader is not attached to a stream
 * Invalid state: Controller is already closed
 * Invalid state: WritableStream is closed
 */
export function isStreamReaderReleaseError(e: unknown) {
  const allowedMessages = [
    'Invalid state: Releasing reader',
    'Invalid state: The reader is not attached to a stream',
    'Controller is already closed',
    'WritableStream is closed',
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
  private writerClosed: boolean = false;

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
   * Can be called again after detachSource() to attach a new source.
   */
  setSource(source: ReadableStream<T>) {
    if (this.isSourceSet) {
      throw new Error('Stream source already set');
    }

    // If writer was closed from a previous source, recreate the transform
    if (this.writerClosed) {
      this.transform = new IdentityTransform<T>();
      this.writer = this.transform.writable.getWriter();
      this.writerClosed = false;
    }

    this.sourceReader = source.getReader();
    this.pump();
  }

  private async pump() {
    let sourceError: unknown;
    let detached = false;

    try {
      while (true) {
        // Check if source was detached (sourceReader set to undefined)
        if (!this.sourceReader) {
          detached = true;
          break;
        }
        const { done, value } = await this.sourceReader.read();
        if (done) break;
        await this.writer.write(value);
      }
    } catch (e) {
      // Skip stream cleanup related errors (happens when detachSource is called)
      if (isStreamReaderReleaseError(e)) {
        detached = true;
      } else {
        sourceError = e;
      }
    } finally {
      // any other error from source will be propagated to the consumer
      if (sourceError) {
        try {
          this.writer.abort(sourceError);
        } catch (e) {
          // ignore if writer is already closed
        }
        this.writerClosed = true;
        return;
      }

      // release lock so this.stream.getReader().read() will terminate with done: true
      try {
        this.writer.releaseLock();
      } catch (e) {
        // ignore if writer lock is already released
      }

      // we only close the writable stream after done
      try {
        await this.transform.writable.close();
        this.writerClosed = true;
        // NOTE: we do not cancel this.transform.readable as there might be access to
        // this.transform.readable.getReader() outside that blocks this cancellation
        // hence, user is responsible for canceling reader on their own
      } catch (e) {
        // ignore TypeError: Invalid state: WritableStream is closed
        // in case stream reader is already closed, this will throw
        // but we ignore it as we are closing the stream anyway
        this.writerClosed = true;
      }
    }
  }

  /**
   * Detach the source stream and clean up resources.
   * After calling this, setSource() can be called again with a new source.
   */
  async detachSource() {
    if (!this.isSourceSet) {
      // No-op if source was never set - this is a common case during cleanup
      return;
    }

    // release lock will make any pending read() throw TypeError
    // which are expected, and we intentionally catch those error
    // using isStreamReaderReleaseError
    // this will unblock any pending read() inside the async for loop
    this.sourceReader!.releaseLock();

    // Reset sourceReader so isSourceSet returns false
    // This allows setSource() to be called again on reconnection
    this.sourceReader = undefined;
  }
}
