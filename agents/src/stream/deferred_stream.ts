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
    if (this.pipeTask) {
      throw new Error('Stream source already set');
    }

    this.pipeTask = createTask(async (controller) => {
      try {
        const reader = source.getReader();

        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          await this.writer.write(value);
        }

        this.writer.releaseLock();
        reader.releaseLock();

        // we only close the writable stream after done
        await this.transform.writable.close();
        // NOTE: we do not cancel readable stream as there might be access to
        // this transform.readable.getReader() outside that blocks thed cancellation
        // and user using this deferred readable stream should cancel reader on their own
      } catch (e) {
        this.writer.abort(e);
      }
    });
  }

  /**
   * Cancel the stream and clean up resources.
   */
  async cancel() {
    this.pipeTask?.cancel();
    await this.pipeTask?.result;
  }
}
