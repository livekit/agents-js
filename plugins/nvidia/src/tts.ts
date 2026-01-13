// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import {
  type APIConnectOptions,
  AudioByteStream,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { TTSLanguages, TTSVoices } from './models.js';

const DEFAULT_SERVER = 'grpc.nvcf.nvidia.com:443';
const DEFAULT_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';
const DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Leo';
const NUM_CHANNELS = 1;
const BUFFERED_WORDS_COUNT = 8;

export interface TTSOptions {
  apiKey?: string;
  voice: TTSVoices | string;
  functionId: string;
  languageCode: TTSLanguages | string;
  sampleRate: number;
  server: string;
  useSsl: boolean;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.NVIDIA_API_KEY,
  voice: DEFAULT_VOICE,
  functionId: DEFAULT_FUNCTION_ID,
  languageCode: 'en-US',
  sampleRate: 16000,
  server: DEFAULT_SERVER,
  useSsl: true,
};

interface SynthesizeSpeechRequest {
  text: string;
  languageCode: string;
  encoding: number;
  sampleRateHz: number;
  voiceName: string;
}

interface SynthesizeSpeechResponse {
  audio: string; // base64 encoded audio
}

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #logger = log();
  label = 'nvidia.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(opts.sampleRate || defaultTTSOptions.sampleRate, NUM_CHANNELS, {
      streaming: true,
    });

    this.#opts = { ...defaultTTSOptions, ...opts };

    if (this.#opts.useSsl && !this.#opts.apiKey) {
      throw new Error(
        'NVIDIA API key is required when using SSL. Either pass apiKey parameter, set NVIDIA_API_KEY environment variable, or disable SSL and use a locally hosted Riva NIM service.',
      );
    }

    this.#logger.info(
      { voice: this.#opts.voice, server: this.#opts.server },
      'Initializing NVIDIA TTS',
    );
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(text: string, connOptions?: APIConnectOptions): ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions);
  }

  stream(): SynthesizeStream {
    return new SynthesizeStream(this, this.#opts);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  #opts: TTSOptions;
  #text: string;
  #logger = log();
  label = 'nvidia.ChunkedStream';

  constructor(tts: TTS, text: string, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(text, tts, connOptions);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

    const credentials = this.#opts.useSsl
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    const metadata = new grpc.Metadata();
    if (this.#opts.apiKey) {
      metadata.set('authorization', `Bearer ${this.#opts.apiKey}`);
    }
    metadata.set('function-id', this.#opts.functionId);

    const serviceDef = this.createServiceDefinition();
    const ServiceClient = grpc.makeGenericClientConstructor(serviceDef, 'RivaSpeechSynthesis');
    const client = new ServiceClient(this.#opts.server, credentials);

    try {
      const request: SynthesizeSpeechRequest = {
        text: this.#text,
        languageCode: this.#opts.languageCode,
        encoding: 1, // LINEAR_PCM
        sampleRateHz: this.#opts.sampleRate,
        voiceName: this.#opts.voice,
      };

      await new Promise<void>((resolve, reject) => {
        const call = (
          client as unknown as {
            SynthesizeOnline: (
              request: SynthesizeSpeechRequest,
              metadata: grpc.Metadata,
            ) => grpc.ClientReadableStream<SynthesizeSpeechResponse>;
          }
        ).SynthesizeOnline(request, metadata);

        call.on('data', (response: SynthesizeSpeechResponse) => {
          if (response.audio) {
            const audioBuffer = Buffer.from(response.audio, 'base64');
            const arrayBuffer = audioBuffer.buffer.slice(
              audioBuffer.byteOffset,
              audioBuffer.byteOffset + audioBuffer.byteLength,
            );
            for (const frame of bstream.write(arrayBuffer)) {
              this.queue.put({
                requestId,
                frame,
                final: false,
                segmentId: requestId,
              });
            }
          }
        });

        call.on('error', (error: Error) => {
          this.#logger.error({ error }, 'NVIDIA TTS synthesis error');
          reject(error);
        });

        call.on('end', () => {
          // Flush remaining audio
          for (const frame of bstream.flush()) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
          resolve();
        });
      });
    } finally {
      client.close();
    }
  }

  private createServiceDefinition(): grpc.ServiceDefinition {
    return {
      SynthesizeOnline: {
        path: '/nvidia.riva.tts.RivaSpeechSynthesis/SynthesizeOnline',
        requestStream: false,
        responseStream: true,
        requestSerialize: (value: unknown) => Buffer.from(JSON.stringify(value)),
        requestDeserialize: (value: Buffer) => JSON.parse(value.toString()),
        responseSerialize: (value: unknown) => Buffer.from(JSON.stringify(value)),
        responseDeserialize: (value: Buffer) => JSON.parse(value.toString()),
      },
    };
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  #tokenizer = new tokenize.basic.SentenceTokenizer({
    minSentenceLength: BUFFERED_WORDS_COUNT,
  }).stream();
  #grpcClient: grpc.Client | null = null;
  label = 'nvidia.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#opts = opts;
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

    const credentials = this.#opts.useSsl
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    const metadata = new grpc.Metadata();
    if (this.#opts.apiKey) {
      metadata.set('authorization', `Bearer ${this.#opts.apiKey}`);
    }
    metadata.set('function-id', this.#opts.functionId);

    const serviceDef = this.createServiceDefinition();
    const ServiceClient = grpc.makeGenericClientConstructor(serviceDef, 'RivaSpeechSynthesis');
    this.#grpcClient = new ServiceClient(this.#opts.server, credentials);

    const inputTask = async () => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.#tokenizer.flush();
          continue;
        }
        this.#tokenizer.pushText(data);
      }
      this.#tokenizer.endInput();
      this.#tokenizer.close();
    };

    const synthesizeTask = async () => {
      for await (const event of this.#tokenizer) {
        if (this.closed || this.abortController.signal.aborted) break;

        const text = event.token;
        if (!text.trim()) continue;

        await this.synthesizeText(text, requestId, bstream, metadata);
      }

      // Flush remaining audio
      for (const frame of bstream.flush()) {
        if (!this.queue.closed) {
          this.queue.put({
            requestId,
            frame,
            final: false,
            segmentId: requestId,
          });
        }
      }

      if (!this.queue.closed) {
        this.queue.put(SynthesizeStream.END_OF_STREAM);
      }
    };

    try {
      await Promise.all([inputTask(), synthesizeTask()]);
    } finally {
      if (this.#grpcClient) {
        this.#grpcClient.close();
        this.#grpcClient = null;
      }
    }
  }

  private async synthesizeText(
    text: string,
    requestId: string,
    bstream: AudioByteStream,
    metadata: grpc.Metadata,
  ): Promise<void> {
    if (!this.#grpcClient) return;

    const request: SynthesizeSpeechRequest = {
      text,
      languageCode: this.#opts.languageCode,
      encoding: 1, // LINEAR_PCM
      sampleRateHz: this.#opts.sampleRate,
      voiceName: this.#opts.voice,
    };

    return new Promise<void>((resolve, reject) => {
      const call = (
        this.#grpcClient as unknown as {
          SynthesizeOnline: (
            request: SynthesizeSpeechRequest,
            metadata: grpc.Metadata,
          ) => grpc.ClientReadableStream<SynthesizeSpeechResponse>;
        }
      ).SynthesizeOnline(request, metadata);

      call.on('data', (response: SynthesizeSpeechResponse) => {
        if (response.audio && !this.queue.closed) {
          const audioBuffer = Buffer.from(response.audio, 'base64');
          const arrayBuffer = audioBuffer.buffer.slice(
            audioBuffer.byteOffset,
            audioBuffer.byteOffset + audioBuffer.byteLength,
          );
          for (const frame of bstream.write(arrayBuffer)) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
        }
      });

      call.on('error', (error: Error) => {
        this.#logger.error({ error }, 'NVIDIA TTS synthesis error');
        reject(error);
      });

      call.on('end', () => {
        resolve();
      });
    });
  }

  private createServiceDefinition(): grpc.ServiceDefinition {
    return {
      SynthesizeOnline: {
        path: '/nvidia.riva.tts.RivaSpeechSynthesis/SynthesizeOnline',
        requestStream: false,
        responseStream: true,
        requestSerialize: (value: unknown) => Buffer.from(JSON.stringify(value)),
        requestDeserialize: (value: Buffer) => JSON.parse(value.toString()),
        responseSerialize: (value: unknown) => Buffer.from(JSON.stringify(value)),
        responseDeserialize: (value: Buffer) => JSON.parse(value.toString()),
      },
    };
  }
}
