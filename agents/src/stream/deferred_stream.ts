// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type ReadableStream } from 'node:stream/web';
import { IdentityTransform } from './identity_transform.js';


/**
 * Check if error is related to reader.read after release lock
 * 
 * Invalid state: Releasing reader
 * Invalid state: The reader is not attached to a stream
 */
function isStreamReaderReleaseError(e: unknown) {
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
      if (isStreamReaderReleaseError(e)) return;
      sourceError = e;
    } finally {
      if (sourceError) {
        this.writer.abort(sourceError);
        return;
      }

      this.writer.releaseLock();

      // we only close the writable stream after done
      try {
        await this.transform.writable.close();
      } catch (e) {
        // ignore TypeError: Invalid state: WritableStream is closed
      }

      // we only close the writable stream after done
      // await this.transform.writable.close();
      // NOTE: we do not cancel this.transform.readable as there might be access to
      // this.transform.readable.getReader() outside that blocks this cancellation
      // hence, user is responsible for canceling reader on their own
    }
  }

  /**
   * Detach the source stream and clean up resources.
   */
  async detachSource() {
    if (!this.isSourceSet) {
      throw new Error('Source not set');
    }

    this.sourceReader!.releaseLock();
  }
}
