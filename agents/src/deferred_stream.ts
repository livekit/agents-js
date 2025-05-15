// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { Future } from './utils.js';

export class DeferredReadableStream<T> {
  private _sourceFuture: Future<ReadableStream<T>>;

  private _reader?: ReadableStreamDefaultReader<T>;

  public readonly stream: ReadableStream<T>;

  constructor() {
    this._sourceFuture = new Future<ReadableStream<T>>();

    this.stream = new ReadableStream<T>({
      start: async (controller) => {
        try {
          const source = await this._sourceFuture.await;

          this._reader = source.getReader();

          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await this._reader!.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          };

          pump();
        } catch (err) {
          controller.error(err);
        }
      },
      cancel: async (reason) => {
        await this.cancel(reason);
      },
    });
  }

  /**
   * Call once the actual source is ready.
   */
  setSource(source: ReadableStream<T>) {
    if (this._sourceFuture.done) {
      return;
    }
    this._sourceFuture.resolve(source);
  }

  async cancel(reason?: Error) {
    if (!this._sourceFuture.done) {
      this._sourceFuture.reject(reason ?? new Error('Stream cancelled without reason'));
    }
    await this._reader?.cancel(reason);
  }
}
