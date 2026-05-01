// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  log,
  tts,
} from '@livekit/agents';
import { Mistral } from '@mistralai/mistralai';
import * as crypto from 'node:crypto';
import type { MistralTTSModels } from './models.js';

// Confirmed from WAV header: Mistral TTS PCM output is 24000 Hz, mono, 16-bit signed
const MISTRAL_TTS_SAMPLE_RATE = 24000;
const MISTRAL_TTS_CHANNELS = 1;

export interface TTSOptions {
  /**
   * Mistral API key. Defaults to the MISTRAL_API_KEY environment variable.
   */
  apiKey?: string;
  /**
   * TTS model to use.
   * @default 'voxtral-mini-tts-2603'
   */
  model?: MistralTTSModels | string;
  /**
   * Preset voice ID to use for synthesis. Use `listVoices()` to enumerate available voices.
   * If omitted, the API may select a default voice.
   */
  voiceId?: string;
  /**
   * Base URL for the Mistral API.
   */
  baseURL?: string;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.MISTRAL_API_KEY,
  model: 'voxtral-mini-tts-2603',
};

export class TTS extends tts.TTS {
  #opts: Required<Omit<TTSOptions, 'voiceId' | 'baseURL'>> &
    Pick<TTSOptions, 'voiceId' | 'baseURL'>;
  #client: Mistral;
  #logger = log();

  label = 'mistral.TTS';

  constructor(opts: TTSOptions = {}) {
    super(MISTRAL_TTS_SAMPLE_RATE, MISTRAL_TTS_CHANNELS, { streaming: false });

    this.#opts = {
      ...defaultTTSOptions,
      ...opts,
    } as Required<Omit<TTSOptions, 'voiceId' | 'baseURL'>> &
      Pick<TTSOptions, 'voiceId' | 'baseURL'>;

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'Mistral API key is required, either as an argument or set the MISTRAL_API_KEY environment variable',
      );
    }

    this.#client = new Mistral({
      apiKey: this.#opts.apiKey,
      serverURL: this.#opts.baseURL,
    });
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'mistral';
  }

  /**
   * List all available preset voices.
   */
  async listVoices(): Promise<{ id: string; name: string; slug: string; languages: string[] }[]> {
    const result = await this.#client.audio.voices.list();
    return (result.items ?? []).map((v: any) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      languages: v.languages ?? [],
    }));
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, this.#client, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Mistral TTS does not support streaming synthesis — use synthesize() instead');
  }

  async close(): Promise<void> {
    // HTTP-based, no persistent connections to clean up
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'mistral.ChunkedStream';
  #client: Mistral;
  #opts: TTSOptions;
  #text: string;

  constructor(
    ttsInstance: TTS,
    text: string,
    client: Mistral,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#client = client;
    this.#opts = opts;
    this.#text = text;
  }

  protected async run(): Promise<void> {
    const logger = log();
    try {
      const eventStream = await this.#client.audio.speech.complete(
        {
          input: this.#text,
          model: this.#opts.model ?? 'voxtral-mini-tts-2603',
          voiceId: this.#opts.voiceId,
          responseFormat: 'pcm',
          stream: true,
        },
        {
          fetchOptions: { signal: this.abortController?.signal },
        },
      );

      const requestId = crypto.randomUUID();
      const segmentId = crypto.randomUUID();
      const audioByteStream = new AudioByteStream(MISTRAL_TTS_SAMPLE_RATE, MISTRAL_TTS_CHANNELS);

      let lastFrame: import('@livekit/rtc-node').AudioFrame | undefined;

      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      for await (const event of eventStream) {
        if (event.data.type === 'speech.audio.delta') {
          const pcmBytes = Buffer.from(event.data.audioData, 'base64');
          const frames = audioByteStream.write(pcmBytes);
          for (const frame of frames) {
            sendLastFrame(segmentId, false);
            lastFrame = frame;
          }
        } else if (event.data.type === 'speech.audio.done') {
          break;
        }
      }

      // Flush any remaining buffered audio
      const flushFrames = audioByteStream.flush();
      for (const frame of flushFrames) {
        sendLastFrame(segmentId, false);
        lastFrame = frame;
      }

      sendLastFrame(segmentId, true);
      this.queue.close();
    } catch (error: unknown) {
      if (this.abortController?.signal.aborted) return;

      if (error instanceof APIStatusError || error instanceof APIConnectionError) {
        throw error;
      }

      const err = error as { statusCode?: number; status?: number; message?: string };
      const statusCode = err.statusCode ?? err.status;

      if (statusCode !== undefined) {
        if (statusCode === 429) {
          throw new APIStatusError({
            message: `Mistral TTS: rate limit - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
        if (statusCode >= 400 && statusCode < 500) {
          throw new APIStatusError({
            message: `Mistral TTS: client error (${statusCode}) - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: false },
          });
        }
        if (statusCode >= 500) {
          throw new APIStatusError({
            message: `Mistral TTS: server error (${statusCode}) - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
      }

      throw new APIConnectionError({
        message: `Mistral TTS: ${err.message ?? 'unknown error'}`,
        options: { retryable: true },
      });
    }
  }
}
