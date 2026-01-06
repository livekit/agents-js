import { type AudioBuffer, stt } from '@livekit/agents';
import { combineAudioFrames, type AudioFrame } from '@livekit/rtc-node';
import type { ConfigOption } from './utils.js';

const API_URL = 'https://api.models.hathora.dev/inference/v1/stt';
const AUTHORIZATION_HEADER = 'Authorization';

export interface STTOptions {
  model: string;
  language?: string;
  modelConfig?: ConfigOption[];
  baseURL?: string;
  apiKey?: string;
}

const defaultSTTOptions: Partial<STTOptions> = {
  baseURL: API_URL,
  apiKey: process.env.HATHORA_API_KEY,
};

export class STT extends stt.STT {
  label = 'hathora.STT';
  #opts: STTOptions;
  #url: URL;

  constructor(opts: STTOptions) {
    super({ streaming: false, interimResults: false });

    this.#opts = {
      ...defaultSTTOptions,
      ...opts
    };

    if (opts.baseURL === undefined) {
      this.#opts.baseURL = API_URL;
    }

    // remove trailing slash from baseURL
    const baseURL = this.#opts.baseURL!.replace(/\/$/, '');

    this.#url = new URL(baseURL);

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

  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const headers: HeadersInit = {
      [AUTHORIZATION_HEADER]: `Bearer ${this.#opts.apiKey!}`,
      'Content-Type': 'application/json',
    };

    let body: any = {
      model: this.#opts.model,
    };

    if (this.#opts.language) {
      body.language = this.#opts.language;
    }

    if (this.#opts.modelConfig) {
      body.model_config = this.#opts.modelConfig;
    }

    body.audio = this.#createWav(combineAudioFrames(buffer)).toString('base64');

    const response = await fetch(
      this.#url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortSignal,
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
          language: this.#opts.language || '',
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
