// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import {
  type APIConnectOptions,
  type AudioBuffer,
  AudioByteStream,
  log,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { STTLanguages, STTModels } from './models.js';

const DEFAULT_SERVER = 'grpc.nvcf.nvidia.com:443';
const DEFAULT_FUNCTION_ID = '1598d209-5e27-4d3c-8079-4751568b1081';
const DEFAULT_MODEL = 'parakeet-1.1b-en-US-asr-streaming-silero-vad-sortformer';

export interface STTOptions {
  apiKey?: string;
  model: STTModels;
  functionId: string;
  punctuate: boolean;
  languageCode: STTLanguages | string;
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

interface RecognitionConfig {
  encoding: number;
  sampleRateHertz: number;
  languageCode: string;
  maxAlternatives: number;
  enableAutomaticPunctuation: boolean;
  audioChannelCount: number;
  enableWordTimeOffsets: boolean;
  model: string;
}

interface StreamingRecognitionConfig {
  config: RecognitionConfig;
  interimResults: boolean;
}

interface WordInfo {
  startTime: number;
  endTime: number;
  word: string;
  confidence: number;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
  words: WordInfo[];
}

interface StreamingRecognitionResult {
  alternatives: SpeechRecognitionAlternative[];
  isFinal: boolean;
  stability: number;
  channelTag: number;
  audioProcessed: number;
}

interface StreamingRecognizeResponse {
  results: StreamingRecognitionResult[];
}

export class STT extends stt.STT {
  #opts: STTOptions;
  #logger = log();
  label = 'nvidia.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    super({
      streaming: true,
      interimResults: opts.punctuate ?? defaultSTTOptions.punctuate,
    });

    this.#opts = { ...defaultSTTOptions, ...opts };

    if (this.#opts.useSsl && !this.#opts.apiKey) {
      throw new Error(
        'NVIDIA API key is required when using SSL. Either pass apiKey parameter, set NVIDIA_API_KEY environment variable, or disable SSL and use a locally hosted Riva NIM service.',
      );
    }

    this.#logger.info(
      { model: this.#opts.model, server: this.#opts.server },
      'Initializing NVIDIA STT',
    );
  }

  async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Recognize is not supported on NVIDIA STT, use stream() instead');
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #logger = log();
  #speaking = false;
  #requestId = '';
  #grpcClient: grpc.Client | null = null;
  #call: grpc.ClientDuplexStream<unknown, unknown> | null = null;
  label = 'nvidia.SpeechStream';

  constructor(stt: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = opts;
  }

  protected async run() {
    const credentials = this.#opts.useSsl
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    const metadata = new grpc.Metadata();
    if (this.#opts.apiKey) {
      metadata.set('authorization', `Bearer ${this.#opts.apiKey}`);
    }
    metadata.set('function-id', this.#opts.functionId);

    const serviceDef = this.createServiceDefinition();
    const ServiceClient = grpc.makeGenericClientConstructor(serviceDef, 'RivaSpeechRecognition');

    this.#grpcClient = new ServiceClient(this.#opts.server, credentials);

    const streamingConfig: StreamingRecognitionConfig = {
      config: {
        encoding: 1, // LINEAR_PCM
        sampleRateHertz: this.#opts.sampleRate,
        languageCode: this.#opts.languageCode,
        maxAlternatives: 1,
        enableAutomaticPunctuation: this.#opts.punctuate,
        audioChannelCount: 1,
        enableWordTimeOffsets: true,
        model: this.#opts.model,
      },
      interimResults: true,
    };

    try {
      await this.runRecognition(streamingConfig, metadata);
    } finally {
      if (this.#grpcClient) {
        this.#grpcClient.close();
        this.#grpcClient = null;
      }
    }
  }

  private createServiceDefinition(): grpc.ServiceDefinition {
    return {
      StreamingRecognize: {
        path: '/nvidia.riva.asr.RivaSpeechRecognition/StreamingRecognize',
        requestStream: true,
        responseStream: true,
        requestSerialize: (value: unknown) => Buffer.from(JSON.stringify(value)),
        requestDeserialize: (value: Buffer) => JSON.parse(value.toString()),
        responseSerialize: (value: unknown) => Buffer.from(JSON.stringify(value)),
        responseDeserialize: (value: Buffer) => JSON.parse(value.toString()),
      },
    };
  }

  private async runRecognition(
    streamingConfig: StreamingRecognitionConfig,
    metadata: grpc.Metadata,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.#grpcClient) {
        reject(new Error('gRPC client not initialized'));
        return;
      }

      this.#call = (
        this.#grpcClient as grpc.Client & {
          StreamingRecognize: (
            metadata: grpc.Metadata,
          ) => grpc.ClientDuplexStream<unknown, unknown>;
        }
      ).StreamingRecognize(metadata);

      if (!this.#call) {
        reject(new Error('Failed to create streaming call'));
        return;
      }

      // Send initial config
      this.#call.write({ streamingConfig });

      // Handle responses
      this.#call.on('data', (response: StreamingRecognizeResponse) => {
        this.handleResponse(response);
      });

      this.#call.on('error', (error: Error) => {
        if (!this.closed) {
          this.#logger.error({ error }, 'NVIDIA STT stream error');
        }
        reject(error);
      });

      this.#call.on('end', () => {
        resolve();
      });

      // Send audio data
      this.sendAudioData()
        .then(() => {
          if (this.#call) {
            this.#call.end();
          }
        })
        .catch(reject);
    });
  }

  private async sendAudioData(): Promise<void> {
    const samples100Ms = Math.floor(this.#opts.sampleRate / 10);
    const stream = new AudioByteStream(this.#opts.sampleRate, 1, samples100Ms);

    for await (const data of this.input) {
      if (this.closed || !this.#call) break;

      if (data === SpeechStream.FLUSH_SENTINEL) {
        const frames = stream.flush();
        for (const frame of frames) {
          this.sendFrame(frame);
        }
        continue;
      }

      const frames = stream.write(data.data.buffer as ArrayBuffer);
      for (const frame of frames) {
        this.sendFrame(frame);
      }
    }

    // Flush remaining audio
    const remainingFrames = stream.flush();
    for (const frame of remainingFrames) {
      this.sendFrame(frame);
    }
  }

  private sendFrame(frame: AudioFrame): void {
    if (this.#call && !this.closed) {
      this.#call.write({ audioContent: Buffer.from(frame.data.buffer).toString('base64') });
    }
  }

  private handleResponse(response: StreamingRecognizeResponse): void {
    if (!response.results || response.results.length === 0) {
      return;
    }

    for (const result of response.results) {
      if (!result.alternatives || result.alternatives.length === 0) {
        continue;
      }

      const alternative = result.alternatives[0];
      if (!alternative) {
        continue;
      }
      const transcript = alternative.transcript || '';

      if (!transcript.trim()) {
        continue;
      }

      this.#requestId = `nvidia-${Date.now()}`;

      if (!this.#speaking && transcript.trim()) {
        this.#speaking = true;
        this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
      }

      const speechData = this.convertToSpeechData(alternative);

      if (result.isFinal) {
        this.queue.put({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          requestId: this.#requestId,
          alternatives: [speechData],
        });

        if (this.#speaking) {
          this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
          this.#speaking = false;
        }
      } else {
        this.queue.put({
          type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
          requestId: this.#requestId,
          alternatives: [speechData],
        });
      }
    }
  }

  private convertToSpeechData(alternative: SpeechRecognitionAlternative): stt.SpeechData {
    const transcript = alternative.transcript || '';
    const confidence = alternative.confidence || 0.0;
    const words = alternative.words || [];

    let startTime = 0.0;
    let endTime = 0.0;

    if (words.length > 0) {
      startTime = (words[0]?.startTime || 0) / 1000.0;
      endTime = (words[words.length - 1]?.endTime || 0) / 1000.0;
    }

    return {
      language: this.#opts.languageCode,
      startTime,
      endTime,
      confidence,
      text: transcript,
    };
  }
}
