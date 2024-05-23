// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { type AudioBuffer, mergeFrames } from '../utils.js';
import { VADEventType, type VADStream } from '../vad.js';
import { STT, SpeechEvent, SpeechEventType, SpeechStream } from './stt.js';

export class StreamAdapterWrapper extends SpeechStream {
  #closed: boolean;
  #stt: STT;
  #vadStream: VADStream;
  #eventQueue: (SpeechEvent | undefined)[];
  #language?: string;
  #task: {
    run: Promise<void>;
    cancel: () => void;
  };

  constructor(stt: STT, vadStream: VADStream, language: string | undefined = undefined) {
    super();
    this.#closed = false;
    this.#stt = stt;
    this.#vadStream = vadStream;
    this.#eventQueue = [];
    this.#language = language;
    this.#task = {
      run: new Promise((_, reject) => {
        this.run(reject);
      }),
      cancel: () => {},
    };
  }

  async run(reject: (arg: Error) => void) {
    this.#task.cancel = () => {
      this.#closed = true;
      reject(new Error('cancelled'));
    };

    for (const event of this.#vadStream) {
      if (event.type == VADEventType.START_OF_SPEECH) {
        const startEvent = new SpeechEvent(SpeechEventType.START_OF_SPEECH);
        this.#eventQueue.push(startEvent);
      } else if (event.type == VADEventType.END_OF_SPEECH) {
        const mergedFrames = mergeFrames(event.speech);
        const endEvent = await this.#stt.recognize(mergedFrames, this.#language);
        this.#eventQueue.push(endEvent);
      }
    }

    this.#eventQueue.push(undefined);
  }

  pushFrame(frame: AudioFrame) {
    if (this.#closed) {
      throw new TypeError('cannot push frame to closed stream');
    }

    this.#vadStream.pushFrame(frame);
  }

  async close(wait: boolean = true): Promise<void> {
    this.#closed = true;

    if (!wait) {
      this.#task.cancel();
    }

    await this.#vadStream.close(wait);
    await this.#task.run;
  }

  next(): IteratorResult<SpeechEvent> {
    const item = this.#eventQueue.shift();
    if (item) {
      return { done: false, value: item };
    } else {
      return { done: true, value: undefined };
    }
  }
}

export class StreamAdapter extends STT {
  #stt: STT;
  #vadStream: VADStream;

  constructor(stt: STT, vadStream: VADStream) {
    super(true);
    this.#stt = stt;
    this.#vadStream = vadStream;
  }

  async recognize(
    buffer: AudioBuffer,
    language: string | undefined = undefined,
  ): Promise<SpeechEvent> {
    return await this.#stt.recognize(buffer, language);
  }

  stream(language: string | undefined = undefined) {
    return new StreamAdapterWrapper(this.#stt, this.#vadStream, language);
  }
}
