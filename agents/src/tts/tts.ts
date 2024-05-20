// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { mergeFrames } from '../utils.js';

export interface SynthesizedAudio {
  text: string;
  data: AudioFrame;
}

export enum SynthesisEventType {
  STARTED = 0,
  AUDIO = 1,
  FINISHED = 2,
}

export class SynthesisEvent {
  type: SynthesisEventType;
  audio?: SynthesizedAudio;

  constructor(type: SynthesisEventType, audio: SynthesizedAudio | undefined = undefined) {
    this.type = type;
    this.audio = audio;
  }
}

export abstract class SynthesizeStream implements IterableIterator<SynthesisEvent> {
  abstract pushText(token?: string): void;

  markSegmentEnd() {
    this.pushText(undefined);
  }

  abstract close(wait: boolean): Promise<void>;
  abstract next(): IteratorResult<SynthesisEvent>;

  [Symbol.iterator](): SynthesizeStream {
    return this;
  }
}

export abstract class TTS {
  #streamingSupported: boolean;

  constructor(streamingSupported: boolean) {
    this.#streamingSupported = streamingSupported;
  }

  abstract synthesize(text: string): Promise<ChunkedStream>;

  abstract stream(): SynthesizeStream;

  get streamingSupported(): boolean {
    return this.#streamingSupported;
  }
}

export abstract class ChunkedStream implements AsyncIterableIterator<SynthesizedAudio> {
  async collect(): Promise<AudioFrame> {
    const frames = [];
    for await (const ev of this) {
      frames.push(ev.data);
    }
    return mergeFrames(frames);
  }

  abstract close(): Promise<void>;
  abstract next(): Promise<IteratorResult<SynthesizedAudio>>;

  [Symbol.iterator](): ChunkedStream {
    return this;
  }

  [Symbol.asyncIterator](): ChunkedStream {
    return this;
  }
}
