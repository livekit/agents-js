import { type AudioBuffer, mergeFrames, stt } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { STTModels } from './models.js';

const PARAKEET_TDT_API_URL = 'https://app-1c7bebb9-6977-4101-9619-833b251b86d1.app.hathora.dev/v1/transcribe';
const AUTHORIZATION_HEADER = 'Authorization';

export type STTOptions =
  | ParakeetTDTSTTOptions;

export interface BaseSTTOptions {
  baseURL: string;
  apiKey?: string;
  model: STTModels;
}

export interface ParakeetTDTSTTOptions extends BaseSTTOptions {
  model: 'nvidia_parakeet_tdt_v3';
}

const defaultSTTOptions: STTOptions = {
  baseURL: PARAKEET_TDT_API_URL,
  apiKey: process.env.HATHORA_API_KEY,
  model: 'nvidia_parakeet_tdt_v3',
};

export class STT extends stt.STT {
  #opts: STTOptions;
  label = 'hathora.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    super({ streaming: false, interimResults: false });

    this.#opts = {
      ...defaultSTTOptions,
      ...opts
    };

    this.#opts.baseURL = this.#opts.baseURL.replace(/\/$/, '');

    if (this.#opts.apiKey === undefined) {
      throw new Error('Hathora API key is required, whether as an argument or as $HATHORA_API_KEY');
    }
  }

  #createWav(frame: AudioFrame): Buffer {
    const bitsPerSample = 16;
    const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
    const blockAlign = (frame.channels * bitsPerSample) / 8;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + frame.data.byteLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(frame.channels, 22);
    header.writeUInt32LE(frame.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(frame.data.byteLength, 40);
    return Buffer.concat([header, Buffer.from(frame.data.buffer)]);
  }

  async _recognize(buffer: AudioBuffer, language?: string): Promise<stt.SpeechEvent> {
    buffer = mergeFrames(buffer);
    const file = new File([this.#createWav(buffer)], 'audio.wav', { type: 'audio/wav' });

    const headers: HeadersInit = {
      [AUTHORIZATION_HEADER]: `Bearer ${this.#opts.apiKey!}`,
    };

    let body: BodyInit = '';

    if (this.#opts.model === 'nvidia_parakeet_tdt_v3') {
      const data = new FormData();

      data.append('file', file);

      body = data;
    }

    const response = await fetch(
      this.#opts.baseURL,
      {
        method: 'POST',
        headers,
        body,
      },
    );

    if (!response.ok) {
      throw new Error(`STT request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: result.text || '',
          language: language || '',
          startTime: 0,
          endTime: 0,
          confidence: 0,
        },
      ],
    };
  }

  stream(): stt.SpeechStream {
    throw new Error('Streaming is not supported on Hathora STT');
  }
}
