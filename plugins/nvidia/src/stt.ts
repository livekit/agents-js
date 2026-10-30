// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  type AudioBuffer,
  AudioByteStream,
  normalizeLanguage,
  shortuuid,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { createRivaCredentials, createRivaMetadata } from './auth.js';
import { log } from './log.js';
import { type ProtoRecord, RivaSpeechRecognition } from './proto.js';

const DEFAULT_SERVER = 'grpc.nvcf.nvidia.com:443';
const DEFAULT_FUNCTION_ID = '1598d209-5e27-4d3c-8079-4751568b1081';
const DEFAULT_MODEL = 'parakeet-1.1b-en-US-asr-streaming-silero-vad-sortformer';

export interface STTOptions {
  apiKey?: string;
  model: string;
  functionId: string;
  punctuate: boolean;
  languageCode: string;
  sampleRate: number;
  server: string;
  useSsl: boolean;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.NVIDIA_API_KEY,
  model: DEFAULT_MODEL,
  functionId: DEFAULT_FUNCTION_ID,
  punctuate: true,
  languageCode: 'en-US',
  sampleRate: 16000,
  server: DEFAULT_SERVER,
  useSsl: true,
};

interface WordInfo {
  startTime?: number;
  endTime?: number;
}

interface SpeechRecognitionAlternative {
  transcript?: string;
  confidence?: number;
  words?: WordInfo[];
}

interface StreamingRecognitionResult {
  alternatives?: SpeechRecognitionAlternative[];
  isFinal?: boolean;
}

interface StreamingRecognizeResponse {
  results?: StreamingRecognitionResult[];
  id?: { value?: string };
}

interface ModelConfig {
  modelName?: string;
  parameters?: Record<string, string>;
}

export class STT extends stt.STT {
  #opts: STTOptions;
  label = 'nvidia.STT';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'NVIDIA';
  }

  constructor(opts: Partial<STTOptions> = {}) {
    const resolvedOpts = { ...defaultSTTOptions, ...opts };
    super({ streaming: true, interimResults: true });
    if (resolvedOpts.useSsl && !resolvedOpts.apiKey) {
      throw new Error(
        'NVIDIA API key is required when using SSL. Pass apiKey, set NVIDIA_API_KEY, or disable SSL for a locally hosted Riva NIM service.',
      );
    }
    this.#opts = resolvedOpts;
    log().info({ model: this.#opts.model, server: this.#opts.server }, 'Initializing NVIDIA STT');
  }

  async _recognize(_buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('NVIDIA STT supports streaming recognition only');
  }

  stream(options?: { language?: string; connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(
      this,
      { ...this.#opts, languageCode: options?.language ?? this.#opts.languageCode },
      options?.connOptions,
    );
  }

  async listModels(): Promise<Record<string, { model: string[] }[]>> {
    const client = new RivaSpeechRecognition(
      this.#opts.server,
      createRivaCredentials(this.#opts.useSsl),
    );
    try {
      const response = await new Promise<ProtoRecord>((resolve, reject) => {
        client.GetRivaSpeechRecognitionConfig(
          {},
          createRivaMetadata(this.#opts.apiKey, this.#opts.functionId),
          (error, value) => (error ? reject(error) : resolve(value)),
        );
      });
      const result: Record<string, { model: string[] }[]> = {};
      for (const config of (response['modelConfig'] as ModelConfig[] | undefined) ?? []) {
        if (config.parameters?.['type'] !== 'online') continue;
        const language = config.parameters['language_code'];
        if (!language || !config.modelName) continue;
        (result[language] ??= []).push({ model: [config.modelName] });
      }
      return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
    } finally {
      client.close();
    }
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #speaking = false;
  #requestId = '';
  label = 'nvidia.SpeechStream';

  constructor(instance: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(instance, opts.sampleRate, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const client = new RivaSpeechRecognition(
      this.#opts.server,
      createRivaCredentials(this.#opts.useSsl),
    );
    const call = client.StreamingRecognize(
      createRivaMetadata(this.#opts.apiKey, this.#opts.functionId),
    );
    const cancel = () => call.cancel();
    this.abortSignal.addEventListener('abort', cancel, { once: true });

    call.write({
      streamingConfig: {
        config: {
          encoding: 'LINEAR_PCM',
          sampleRateHertz: this.#opts.sampleRate,
          languageCode: this.#opts.languageCode,
          maxAlternatives: 1,
          enableAutomaticPunctuation: this.#opts.punctuate,
          audioChannelCount: 1,
          enableWordTimeOffsets: true,
          model: this.#opts.model,
        },
        interimResults: true,
      },
    });

    const receive = new Promise<void>((resolve, reject) => {
      call.on('data', (response: StreamingRecognizeResponse) => this.#handleResponse(response));
      call.on('end', resolve);
      call.on('error', (error) => {
        if (this.abortSignal.aborted) resolve();
        else
          reject(new APIConnectionError({ message: `NVIDIA STT stream failed: ${error.message}` }));
      });
    });

    const attempt = new AbortController();
    const send = async () => {
      const stream = new AudioByteStream(this.#opts.sampleRate, 1, this.#opts.sampleRate / 10);
      while (true) {
        const item = await this.input.next({ signal: attempt.signal });
        if (item.done) break;
        const data = item.value;
        if (data === SpeechStream.FLUSH_SENTINEL) {
          for (const frame of stream.flush()) this.#sendFrame(call, frame);
          break;
        }
        for (const frame of stream.write(data.data)) {
          this.#sendFrame(call, frame);
        }
      }
      for (const frame of stream.flush()) this.#sendFrame(call, frame);
      call.end();
    };
    const sendPromise = send();

    try {
      await Promise.all([sendPromise, receive]);
    } finally {
      attempt.abort();
      call.cancel();
      await sendPromise.catch(() => {});
      this.abortSignal.removeEventListener('abort', cancel);
      client.close();
    }
  }

  #sendFrame(
    call: ReturnType<InstanceType<typeof RivaSpeechRecognition>['StreamingRecognize']>,
    frame: AudioFrame,
  ): void {
    call.write({
      audioContent: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
    });
  }

  #handleResponse(response: StreamingRecognizeResponse): void {
    for (const result of response.results ?? []) {
      const alternative = result.alternatives?.[0];
      const transcript = alternative?.transcript?.trim();
      if (!alternative || !transcript) continue;

      this.#requestId = response.id?.value || this.#requestId || shortuuid();
      if (!this.#speaking) {
        this.#speaking = true;
        this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
      }

      const words = alternative.words ?? [];
      const speechData: stt.SpeechData = {
        language: normalizeLanguage(this.#opts.languageCode),
        startTime: (words[0]?.startTime ?? 0) / 1000,
        endTime: (words.at(-1)?.endTime ?? 0) / 1000,
        confidence: alternative.confidence ?? 0,
        text: alternative.transcript ?? '',
      };

      this.queue.put({
        type: result.isFinal
          ? stt.SpeechEventType.FINAL_TRANSCRIPT
          : stt.SpeechEventType.INTERIM_TRANSCRIPT,
        requestId: this.#requestId,
        alternatives: [speechData],
      });

      if (result.isFinal && this.#speaking) {
        this.#speaking = false;
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
      }
    }
  }
}
