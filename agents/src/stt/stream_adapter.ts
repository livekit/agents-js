// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { VAD, VADStream } from '../vad.js';
import { VADEventType } from '../vad.js';
import type { SpeechEvent } from './stt.js';
import { STT, SpeechEventType, SpeechStream } from './stt.js';

export class StreamAdapter extends STT {
  #stt: STT;
  #vad: VAD;

  constructor(stt: STT, vad: VAD) {
    super({ streaming: true, interimResults: false });
    this.#stt = stt;
    this.#vad = vad;
  }

  recognize(frame: AudioFrame): Promise<SpeechEvent> {
    return this.#stt.recognize(frame);
  }

  stream(): StreamAdapterWrapper {
    return new StreamAdapterWrapper(this.#stt, this.#vad);
  }
}

export class StreamAdapterWrapper extends SpeechStream {
  #stt: STT;
  #vadStream: VADStream;

  constructor(stt: STT, vad: VAD) {
    super();
    this.#stt = stt;
    this.#vadStream = vad.stream();

    this.#run();
  }

  async #run() {
    const forwardInput = async () => {
      for await (const input of this.input) {
        if (input === SpeechStream.FLUSH_SENTINEL) {
          this.#vadStream.flush();
        } else {
          this.#vadStream.pushFrame(input);
        }
      }
      this.#vadStream.endInput();
    };

    const recognize = async () => {
      for await (const ev of this.#vadStream) {
        switch (ev.type) {
          case VADEventType.START_OF_SPEECH:
            this.queue.put({ type: SpeechEventType.START_OF_SPEECH, alternatives: [] });
            break;
          case VADEventType.END_OF_SPEECH:
            this.queue.put({ type: SpeechEventType.END_OF_SPEECH, alternatives: [] });

            const event = await this.#stt.recognize(ev.frames);
            if (!event.alternatives.length || !event.alternatives[0].text) {
              continue;
            }

            this.queue.put(event);
            break;
        }
      }
    };

    Promise.all([forwardInput(), recognize()]);
  }
}
