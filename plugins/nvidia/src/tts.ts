// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  AudioByteStream,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { createRivaCredentials, createRivaMetadata } from './auth.js';
import { type ProtoRecord, RivaSpeechSynthesis } from './proto.js';

const DEFAULT_SERVER = 'grpc.nvcf.nvidia.com:443';
const DEFAULT_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';
const DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Leo';
const NUM_CHANNELS = 1;

export interface TTSOptions {
  apiKey?: string;
  voice: string;
  functionId: string;
  languageCode: string;
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

interface ModelConfig {
  parameters?: Record<string, string>;
}

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'nvidia.TTS';

  get model(): string {
    return this.#opts.voice;
  }

  get provider(): string {
    return 'NVIDIA';
  }

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts = { ...defaultTTSOptions, ...opts };
    super(resolvedOpts.sampleRate, NUM_CHANNELS, { streaming: true });
    if (resolvedOpts.useSsl && !resolvedOpts.apiKey) {
      throw new Error(
        'NVIDIA API key is required when using SSL. Pass apiKey, set NVIDIA_API_KEY, or disable SSL for a locally hosted Riva NIM service.',
      );
    }
    this.#opts = resolvedOpts;
  }

  synthesize(_text: string, _connOptions?: APIConnectOptions): tts.ChunkedStream {
    throw new Error('Chunked synthesis is not supported by NVIDIA TTS');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SynthesizeStream(this, { ...this.#opts }, options?.connOptions);
  }

  async listVoices(): Promise<Record<string, { voices: string[] }>> {
    const client = new RivaSpeechSynthesis(
      this.#opts.server,
      createRivaCredentials(this.#opts.useSsl),
    );
    try {
      const response = await new Promise<ProtoRecord>((resolve, reject) => {
        client.GetRivaSynthesisConfig(
          {},
          createRivaMetadata(this.#opts.apiKey, this.#opts.functionId),
          (error, value) => (error ? reject(error) : resolve(value)),
        );
      });
      const result: Record<string, { voices: string[] }> = {};
      for (const config of (response['modelConfig'] as ModelConfig[] | undefined) ?? []) {
        const language = config.parameters?.['language_code'] ?? 'unknown';
        const voice = config.parameters?.['voice_name'] ?? 'unknown';
        const subvoices = config.parameters?.['subvoices'];
        const voices = subvoices
          ? subvoices.split(',').map((item) => `${voice}.${item.split(':')[0]}`)
          : [voice];
        (result[language] ??= { voices: [] }).voices.push(...voices);
      }
      return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
    } finally {
      client.close();
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #tokenizer = new tokenize.blingfire.SentenceTokenizer().stream();
  label = 'nvidia.SynthesizeStream';

  constructor(instance: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(instance, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const client = new RivaSpeechSynthesis(
      this.#opts.server,
      createRivaCredentials(this.#opts.useSsl),
    );
    const requestId = shortuuid();
    const segmentId = requestId;
    const audio = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    let lastFrame: AudioFrame | undefined;

    const emitFrame = (frame: AudioFrame, final: boolean) => {
      this.queue.put({ requestId, segmentId, frame, final });
    };
    const attempt = new AbortController();
    const inputTask = async () => {
      while (true) {
        const item = await this.input.next({ signal: attempt.signal });
        if (item.done) break;
        const data = item.value;
        if (data === SynthesizeStream.FLUSH_SENTINEL) this.#tokenizer.flush();
        else this.#tokenizer.pushText(data);
      }
      this.#tokenizer.endInput();
      this.#tokenizer.close();
    };
    const synthesizeTask = async () => {
      for await (const event of this.#tokenizer) {
        if (!event.token.trim()) continue;
        this.markStarted();
        this.connOptions.maxRetry = 0;
        await this.#synthesizeText(client, event.token, (chunk) => {
          for (const frame of audio.write(chunk)) {
            if (lastFrame) emitFrame(lastFrame, false);
            lastFrame = frame;
          }
        });
      }
    };

    try {
      await Promise.all([inputTask(), synthesizeTask()]);
      for (const frame of audio.flush()) {
        if (lastFrame) emitFrame(lastFrame, false);
        lastFrame = frame;
      }
      if (lastFrame) emitFrame(lastFrame, true);
      if (!this.queue.closed) this.queue.put(SynthesizeStream.END_OF_STREAM);
    } finally {
      attempt.abort();
      this.#tokenizer.close();
      client.close();
    }
  }

  async #synthesizeText(
    client: InstanceType<typeof RivaSpeechSynthesis>,
    text: string,
    onAudio: (audio: Buffer) => void,
  ): Promise<void> {
    const call = client.SynthesizeOnline(
      {
        text,
        languageCode: this.#opts.languageCode,
        encoding: 'LINEAR_PCM',
        sampleRateHz: this.#opts.sampleRate,
        voiceName: this.#opts.voice,
      },
      createRivaMetadata(this.#opts.apiKey, this.#opts.functionId),
    );
    const cancel = () => call.cancel();
    this.abortSignal.addEventListener('abort', cancel, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        call.on('data', (response: ProtoRecord) => {
          const chunk = response['audio'];
          if (Buffer.isBuffer(chunk) && chunk.length > 0) onAudio(chunk);
        });
        call.on('end', resolve);
        call.on('error', (error) => {
          if (this.abortSignal.aborted) resolve();
          else reject(new APIConnectionError({ message: `NVIDIA TTS failed: ${error.message}` }));
        });
      });
    } finally {
      this.abortSignal.removeEventListener('abort', cancel);
    }
  }
}
