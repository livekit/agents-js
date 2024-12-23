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
  label: string;

  constructor(stt: STT, vad: VAD) {
    super({ streaming: true, interimResults: false });
    this.#stt = stt;
    this.#vad = vad;
    this.label = `stt.StreamAdapter<${this.#stt.label}>`;

    this.#stt.on(SpeechEventType.METRICS_COLLECTED, (metrics) => {
      this.emit(SpeechEventType.METRICS_COLLECTED, metrics);
    });
  }

  _recognize(frame: AudioFrame): Promise<SpeechEvent> {
    return this.#stt.recognize(frame);
  }

  stream(): StreamAdapterWrapper {
    return new StreamAdapterWrapper(this.#stt, this.#vad);
  }
}

export class StreamAdapterWrapper extends SpeechStream {
  #stt: STT;
  #vadStream: VADStream;
  label: string;

  constructor(stt: STT, vad: VAD) {
    super(stt);
    this.#stt = stt;
    this.#vadStream = vad.stream();
    this.label = `stt.StreamAdapterWrapper<${this.#stt.label}>`;

    this.#run();
  }

  async monitorMetrics() {
    return; // do nothing
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
            this.output.put({ type: SpeechEventType.START_OF_SPEECH });
            break;
          case VADEventType.END_OF_SPEECH:
            this.output.put({ type: SpeechEventType.END_OF_SPEECH });

            const event = await this.#stt.recognize(ev.frames);
            if (!event.alternatives![0].text) {
              continue;
            }

            this.output.put(event);
            break;
        }
      }
    };

    Promise.all([forwardInput(), recognize()]);
  }
}
