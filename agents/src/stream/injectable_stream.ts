import { Mutex } from '@livekit/mutex';
import { mergeReadableStreams } from '@std/streams';
import { IdentityTransform } from './identity_transform.js';

export class InjectableStream<T> {
  private source: ReadableStream<T>;
  private identityStream: IdentityTransform<T>;
  private mergedStream: ReadableStream<T>;
  private injectMutex = new Mutex();

  constructor(source: ReadableStream<T>) {
    this.source = source;
    this.identityStream = new IdentityTransform<T>();
    this.mergedStream = mergeReadableStreams<T>(this.source, this.identityStream.readable);
  }

  async inject(value: T) {
    const unlock = await this.injectMutex.lock();
    try {
      const writer = this.identityStream.writable.getWriter();
      await writer.write(value);
      await writer.close();
    } finally {
      unlock();
    }
  }

  async close() {
    const unlock = await this.injectMutex.lock();
    try {
      // this will not cancel the source stream but instead keep the readable open until the source finishes
      await this.identityStream.writable.close();
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
