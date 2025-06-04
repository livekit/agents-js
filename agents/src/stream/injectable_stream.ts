import { Mutex } from '@livekit/mutex';
import { mergeReadableStreams } from '@std/streams';
import { IdentityTransform } from './identity_transform.js';

export class InjectableStream<T> {
  private source: ReadableStream<T>;
  private identityStream: IdentityTransform<T>;
  private mergedStream: ReadableStream<T>;
  private injectMutex = new Mutex();
  private writer: WritableStreamDefaultWriter<T>;
  private closed = false;

  constructor(source: ReadableStream<T>) {
    this.source = source;
    this.identityStream = new IdentityTransform<T>();
    this.mergedStream = mergeReadableStreams<T>(this.source, this.identityStream.readable);
    this.writer = this.identityStream.writable.getWriter();
  }

  async inject(value: T) {
    const unlock = await this.injectMutex.lock();

    if (this.closed) {
      throw new Error('Cannot inject into a closed stream');
    }

    try {
      await this.writer.write(value);
    } finally {
      unlock();
    }
  }

  async close() {
    const unlock = await this.injectMutex.lock();
    try {
      // this will not cancel the source stream but instead keep the readable open until the source finishes
      this.writer.releaseLock();
      await this.identityStream.writable.close();
      this.closed = true;
    } finally {
      unlock();
    }
  }

  async cancel(reason?: any) {
    await Promise.all([
      this.mergedStream.cancel(reason),
      this.identityStream.writable.abort(reason),
    ]);
  }

  get readable() {
    return this.mergedStream;
  }
}
