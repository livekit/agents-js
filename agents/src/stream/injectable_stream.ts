import { Mutex } from '@livekit/mutex';
import { mergeReadableStreams } from '@std/streams';
import type { ReadableStream } from 'node:stream/web';
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

    if (this.closed) {
      return;
    }

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
    await this.close();
    await Promise.all([
      this.mergedStream.cancel(reason),
      this.identityStream.writable.abort(reason),
    ]);
  }

  get readable() {
    return this.mergedStream;
  }
}

// // Copied from @std/streams/merge-readable-streams.ts to avoid incompetible ReadableStream types
// export function mergeReadableStreams<T>(
//   ...streams: ReadableStream<T>[]
// ): ReadableStream<T> {
//   const resolvePromises = streams.map(() => Promise.withResolvers<void>());
//   return new ReadableStream<T>({
//     start(controller) {
//       let mustClose = false;
//       Promise.all(resolvePromises.map(({ promise }) => promise))
//         .then(() => {
//           controller.close();
//         })
//         .catch((error) => {
//           mustClose = true;
//           controller.error(error);
//         });
//       for (const [index, stream] of streams.entries()) {
//         (async () => {
//           try {
//             for await (const data of stream) {
//               if (mustClose) {
//                 break;
//               }
//               controller.enqueue(data);
//             }
//             resolvePromises[index]!.resolve();
//           } catch (error) {
//             resolvePromises[index]!.reject(error);
//           }
//         })();
//       }
//     },
//   });
// }
