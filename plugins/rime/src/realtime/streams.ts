// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { ReadableStream } from 'node:stream/web';

/** A bounded Web Stream. Enqueue never waits on the protocol reader. */
export class OutputQueue<T> {
  readonly stream: ReadableStream<T>;
  private controller!: ReadableStreamDefaultController<T>;
  private ended = false;

  constructor(
    private readonly limit: number,
    onCancel: () => void,
  ) {
    this.stream = new ReadableStream<T>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        cancel: () => {
          this.ended = true;
          onCancel();
        },
      },
      { highWaterMark: limit },
    );
  }

  push(value: T): void {
    if (this.ended) return;
    if ((this.controller.desiredSize ?? 0) <= 0) {
      throw new llm.RealtimeError(`Prism output exceeds ${this.limit} queued chunks`);
    }
    this.controller.enqueue(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.controller.close();
  }

  discard(): void {
    // Erroring releases queued audio as well as pending reads.
    this.controller.error(new llm.RealtimeError('Prism output was interrupted'));
    this.ended = true;
  }
}

/** FIFO for acknowledged mutations. Rejections do not poison later operations. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 128) throw new llm.RealtimeError('Too many pending Prism operations');
    this.pending++;
    const result = this.tail.then(operation);
    this.tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.pending--;
      });
    return result;
  }

  async idle(): Promise<void> {
    await this.tail;
  }
}
