import { mergeReadableStreams } from '@std/streams';
import { IdentityTransform } from './identity_transform.js';

export class InjectableStream<T> {
  private source: ReadableStream<T>;
  private identityStream: IdentityTransform<T>;
  private mergedStream: ReadableStream<T>;

  constructor(source: ReadableStream<T>) {
    this.source = source;
    this.identityStream = new IdentityTransform<T>();
    this.mergedStream = mergeReadableStreams<T>(this.source, this.identityStream.readable);
  }

  async inject(value: T) {
    // note this will still fail for parallel writes
    // we can acquire the writer in the constructor but this will lead to the problem with multiple sync loops blocking when trying to write
    this.identityStream.writable.getWriter().write(value);
  }

  async close() {
    // this will not cancel the source stream but instead keep the readable open until the source finishes
    await this.identityStream.writable.close();
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
