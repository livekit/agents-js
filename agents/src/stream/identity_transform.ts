import { TransformStream } from 'node:stream/web';

export class IdentityTransform<T> extends TransformStream<T, T> {
  constructor() {
    super({
      transform: (chunk, controller) => controller.enqueue(chunk),
    });
  }
}
