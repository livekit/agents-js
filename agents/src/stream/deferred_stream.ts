// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type ReadableStream } from 'node:stream/web';
import { type AbortableTask, createTask } from '../utils.js';
import { IdentityTransform } from './identity_transform.js';

export class DeferredReadableStream<T> {
  private transform: IdentityTransform<T>;
  private writer: WritableStreamDefaultWriter<T>;

  private pipeTask?: AbortableTask<void>;
  private sourceReader?: ReadableStreamDefaultReader<T>;

  constructor() {
    this.transform = new IdentityTransform<T>();
    this.writer = this.transform.writable.getWriter();
  }

  get stream() {
    return this.transform.readable;
  }

  /**
   * Call once the actual source is ready.
   */
  setSource(source: ReadableStream<T>) {
    if (this.pipeTask || this.sourceReader) {
      throw new Error('Stream source already set');
    }

    this.sourceReader = source.getReader();
    this.pipeTask = createTask(async (controller) => {
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await this.sourceReader!.read();
          if (done) break;
          await this.writer.write(value);
        }

        this.writer.releaseLock();

        // we only close the writable stream after done
        await this.transform.writable.close();
        // NOTE: we do not cancel this.transform.readable as there might be access to
        // this.transform.readable.getReader() outside that blocks this cancellation
        // hence, user is responsible for canceling reader on their own
      } catch (e) {
        this.writer.abort(e);
      }
    });
  }

  /**
   * Detach the source stream and clean up resources.
   */
  async detachSource() {
    if (!this.pipeTask || !this.sourceReader) {
      throw new Error('Source not set');
    }

    this.sourceReader.releaseLock();

    // TODO(brian): replace with cancelAndWait() after merged with https://github.com/livekit/agents-js/pull/412/files
    this.pipeTask.cancel();
    await this.pipeTask.result;
  }
}
