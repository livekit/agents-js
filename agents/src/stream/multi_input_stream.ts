// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  ReadableStream,
  ReadableStreamDefaultReader,
  WritableStreamDefaultWriter,
} from 'node:stream/web';
import { log } from '../log.js';
import { isStreamReaderReleaseError } from './deferred_stream.js';
import { IdentityTransform } from './identity_transform.js';

/**
 * A fan-in multiplexer that merges multiple {@link ReadableStream} inputs into
 * a single output {@link ReadableStream}. Inputs can be dynamically added and
 * removed at any time while the stream is open.
 *
 * Unlike {@link DeferredReadableStream} which supports a single readable source,
 * `MultiInputStream` allows N concurrent input streams to pump data into one output.
 *
 * Key behaviors:
 * - An error in one input removes that input but does **not** kill the output.
 * - When all inputs end or are removed, the output stays open (waiting for new inputs).
 * - The output only closes when {@link close} is called explicitly.
 * - {@link removeInputStream} releases the reader lock so the source can be reused.
 */
export class MultiInputStream<T> {
  private transform: IdentityTransform<T>;
  private writer: WritableStreamDefaultWriter<T>;
  private inputs: Map<string, ReadableStreamDefaultReader<T>> = new Map();
  private pumpPromises: Map<string, Promise<void>> = new Map();
  private nextId = 0;
  private _closed = false;
  private logger = log();

  constructor() {
    this.transform = new IdentityTransform<T>();
    this.writer = this.transform.writable.getWriter();
  }

  /** The single output stream that consumers read from. */
  get stream(): ReadableStream<T> {
    return this.transform.readable;
  }

  /** Number of currently active input streams. */
  get inputCount(): number {
    return this.inputs.size;
  }

  /** Whether {@link close} has been called. */
  get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Add an input {@link ReadableStream} that will be pumped into the output.
   *
   * @returns A unique identifier that can be passed to {@link removeInputStream}.
   * @throws If the stream has already been closed.
   */
  addInputStream(source: ReadableStream<T>): string {
    if (this._closed) {
      throw new Error('MultiInputStream is closed');
    }

    const id = `input-${this.nextId++}`;
    const reader = source.getReader();
    this.inputs.set(id, reader);

    const pumpDone = this.pumpInput(id, reader);
    this.pumpPromises.set(id, pumpDone);

    return id;
  }

  /**
   * Detach an input stream by its ID and release the reader lock so the
   * source stream can be reused elsewhere.
   *
   * No-op if the ID does not exist (e.g. the input already ended or was removed).
   */
  async removeInputStream(id: string): Promise<void> {
    const reader = this.inputs.get(id);
    if (!reader) return;

    // Delete first so the pump's finally-block is a harmless no-op.
    this.inputs.delete(id);

    // Releasing the lock causes any pending reader.read() inside pump to throw
    // a TypeError, which is caught by isStreamReaderReleaseError.
    reader.releaseLock();

    // Wait for the pump to finish so the caller knows cleanup is complete.
    const pump = this.pumpPromises.get(id);
    if (pump) {
      await pump;
      this.pumpPromises.delete(id);
    }
  }

  /**
   * Close the output stream and detach all inputs.
   *
   * Idempotent — calling more than once is a no-op.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    // Release every input reader to unblock pending reads inside pumps.
    for (const reader of this.inputs.values()) {
      reader.releaseLock();
    }
    this.inputs.clear();

    // Wait for every pump loop to finish before touching the writer.
    await Promise.allSettled([...this.pumpPromises.values()]);
    this.pumpPromises.clear();

    // Close the output writer + writable side of the transform.
    try {
      this.writer.releaseLock();
    } catch {
      // ignore if already released
    }

    try {
      await this.transform.writable.close();
    } catch {
      // ignore if already closed
    }
  }

  private shouldStopPumping(id: string): boolean {
    return this._closed || !this.inputs.has(id);
  }

  private async pumpInput(id: string, reader: ReadableStreamDefaultReader<T>): Promise<void> {
    try {
      while (true) {
        // If the stream was closed or the input was removed while we were
        // awaiting the previous write, bail out immediately.
        if (this.shouldStopPumping(id)) break;

        const { done, value } = await reader.read();
        if (done) break;

        // Double-check after the (potentially long) read.
        if (this.shouldStopPumping(id)) break;

        await this.writer.write(value);
      }
    } catch (e) {
      // TypeErrors from releaseLock() during removeInputStream / close are expected.
      if (!isStreamReaderReleaseError(e)) {
        // For any other error we silently remove the input — the output stays alive.
        // (Contrast with DeferredReadableStream which propagates errors to the output.)
        return;
      }

      this.logger.error({ error: e }, 'Error pumping input stream from MultiInputStream');
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore if already released
      }

      this.inputs.delete(id);
      this.pumpPromises.delete(id);
    }
  }
}
