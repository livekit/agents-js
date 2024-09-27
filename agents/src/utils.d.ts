import type { Room } from '@livekit/rtc-node';
import type { AudioFrame } from '@livekit/rtc-node';

/** Union of a single and a list of {@link AudioFrame}s */
export type AudioBuffer = AudioFrame[] | AudioFrame;
/**
 * Merge one or more {@link AudioFrame}s into a single one.
 *
 * @param buffer Either an {@link AudioFrame} or a list thereof
 * @throws
 * {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypeError
 * | TypeError} if sample rate or channel count are mismatched
 */
export declare const mergeFrames: (buffer: AudioBuffer) => AudioFrame;
export declare const findMicroTrackId: (room: Room, identity: string) => string;
/** @internal */
export declare class Mutex {
  #private;
  constructor(limit?: number);
  isLocked(): boolean;
  lock(): Promise<() => void>;
}
/** @internal */
export declare class Queue<T> {
  #private;
  /** @internal */
  items: T[];
  constructor(limit?: number);
  get(): Promise<T>;
  put(item: T): Promise<void>;
}
/** @internal */
export declare class Future {
  #private;
  get await(): Promise<void>;
  resolve(): void;
  reject(_: Error): void;
}
//# sourceMappingURL=utils.d.ts.map
