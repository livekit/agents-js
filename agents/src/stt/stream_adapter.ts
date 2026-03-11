// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { log } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { isStreamClosedError } from '../utils.js';
import type { VAD, VADStream } from '../vad.js';
import { VADEventType } from '../vad.js';
import type { SpeechEvent, STTRecognizeOptions, STTStreamOptions } from './stt.js';
import { STT, SpeechEventType, SpeechStream } from './stt.js';

export class StreamAdapter extends STT {
  #stt: STT;
  #vad: VAD;
  label: string;

  constructor(stt: STT, vad: VAD) {
    // Ref: python livekit-agents/livekit/agents/stt/stream_adapter.py - 18-31 lines
    super({
      streaming: true,
      interimResults: false,
      offlineRecognize: stt.capabilities.offlineRecognize,
      alignedTranscript: stt.capabilities.alignedTranscript,
    });
    this.#stt = stt;
    this.#vad = vad;
    this.label = `stt.StreamAdapter<${this.#stt.label}>`;

    this.#stt.on('metrics_collected', (metrics) => {
      this.emit('metrics_collected', metrics);
    });

    this.#stt.on('error', (error) => {
      this.emit('error', error);
    });
  }

  // Ref: python livekit-agents/livekit/agents/stt/stream_adapter.py - 45-54 lines
  _recognize(frame: AudioFrame, options?: STTRecognizeOptions): Promise<SpeechEvent> {
    return this.#stt.recognize(frame, options);
  }

  // Ref: python livekit-agents/livekit/agents/stt/stream_adapter.py - 56-68 lines
  stream(options?: STTStreamOptions): StreamAdapterWrapper {
    return new StreamAdapterWrapper(this.#stt, this.#vad, options?.language, options?.connOptions);
  }
}

export class StreamAdapterWrapper extends SpeechStream {
  #stt: STT;
  #vadStream: VADStream;
  #connOptions?: APIConnectOptions;
  #language?: string;
  label: string;

  constructor(stt: STT, vad: VAD, language?: string, connOptions?: APIConnectOptions) {
    super(stt, undefined, connOptions);
    this.#stt = stt;
    this.#vadStream = vad.stream();
    this.#language = language;
    this.#connOptions = connOptions;
    this.label = `stt.StreamAdapterWrapper<${this.#stt.label}>`;
  }

  close() {
    super.close();
    this.#vadStream.close();
  }

  async monitorMetrics() {
    return; // do nothing
  }

  protected async run() {
    // Ref: python livekit-agents/livekit/agents/stt/stream_adapter.py - 97-149 lines
    const forwardInput = async () => {
      for await (const input of this.input) {
        if (input === SpeechStream.FLUSH_SENTINEL) {
          this.#vadStream.flush();
        } else {
          this.#vadStream.pushFrame(input);
        }
      }

      // Guard against calling endInput() on already-closed stream
      // This happens during handover when close() is called while forwardInput is running
      try {
        this.#vadStream.endInput();
      } catch (e) {
        if (isStreamClosedError(e)) {
          return;
        }
        throw e;
      }
    };

    const recognize = async () => {
      for await (const ev of this.#vadStream) {
        switch (ev.type) {
          case VADEventType.START_OF_SPEECH:
            this.output.put({ type: SpeechEventType.START_OF_SPEECH });
            break;
          case VADEventType.END_OF_SPEECH:
            this.output.put({ type: SpeechEventType.END_OF_SPEECH });

            try {
              // Ref: python livekit-agents/livekit/agents/stt/stream_adapter.py - 122-127 lines
              const event = await this.#stt.recognize(ev.frames, {
                abortSignal: this.abortSignal,
                language: this.#language,
                connOptions: this.#connOptions,
              });
              if (!event.alternatives![0].text) {
                continue;
              }

              this.output.put(event);
              break;
            } catch (error) {
              let logger = log();
              if (error instanceof Error) {
                logger = logger.child({ error: error.message });
              } else {
                logger = logger.child({ error });
              }
              logger.error(`${this.label}: provider recognize task failed`);
              continue;
            }
        }
      }
    };

    await Promise.all([forwardInput(), recognize()]);
  }
}
