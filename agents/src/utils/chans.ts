
import { Deferred } from './deferred';

export class Chan<T> {
  private buffer: T[] = [];
  private readers: Deferred<IteratorResult<T>>[] = [];
  private _isClosed = false;

  constructor(size: number = 0) {
    // size is not used in this implementation
  }

  async send(item: T) {
    if (this._isClosed) {
      throw new Error('Channel is closed');
    }
    if (this.readers.length > 0) {
      const reader = this.readers.shift();
      reader?.resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  trySend(item: T): boolean {
    if (this._isClosed) {
      return false;
    }
    if (this.readers.length > 0) {
      const reader = this.readers.shift();
      reader?.resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
    return true;
  }

  async recv(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      const item = this.buffer.shift();
      return { value: item!, done: false };
    }
    if (this._isClosed) {
      return { value: undefined as any, done: true };
    }
    const d = new Deferred<IteratorResult<T>>();
    this.readers.push(d);
    return d.promise;
  }

  tryRecv(): { value: T; done: false } | { value: undefined; done: true } {
    if (this.buffer.length > 0) {
      const item = this.buffer.shift();
      return { value: item!, done: false };
    }
    if (this._isClosed) {
      return { value: undefined, done: true };
    }
    return { value: undefined, done: true };
  }

  close() {
    this._isClosed = true;
    for (const reader of this.readers) {
      reader.resolve({ value: undefined as any, done: true });
    }
    this.readers = [];
  }

  get isClosed(): boolean {
    return this._isClosed;
  }

  isEmpty(): boolean {
    return this.buffer.length === 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const res = await this.recv();
        if (res.done) {
          return { value: undefined, done: true };
        }
        return { value: res.value, done: false };
      },
    };
  }
}
