// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import type { Language } from './models.js';
import {
  API_BASE_URL,
  decodePcmWav,
  ensureSuccessfulResponse,
  isRecord,
  mapFetchError,
  parseJsonResponse,
  responseRequestId,
  timedSignal,
  unwrapData,
  validateLanguage,
} from './utils.js';

const SAMPLE_RATE = 16_000;
const NUM_CHANNELS = 1;
const DEFAULT_VOICE = 'am-hamen';

/**
 * Configuration for Addis Voices 2 speech synthesis.
 *
 * @public
 */
export interface TTSOptions {
  /** Synthesis language: `am` for Amharic or `om` for Afaan Oromo. */
  language: Language | string;
  /** Available voice ID from the dynamic AddisAI voice catalog. */
  voice: string;
  /** Optional Addis Voices 2 speed setting. */
  speed?: number;
  /** AddisAI API key. Defaults to `ADDIS_API_KEY`. */
  apiKey?: string;
  /** AddisAI API base URL. */
  baseURL: string;
  /** Maximum generation time in milliseconds. */
  generationTimeoutMs: number;
  /** Maximum signed-URL download time in milliseconds. */
  downloadTimeoutMs: number;
}

interface ResolvedTTSOptions {
  language: Language;
  voice: string;
  speed?: number;
  apiKey: string;
  baseURL: string;
  generationTimeoutMs: number;
  downloadTimeoutMs: number;
}

const DEFAULT_OPTIONS: Pick<
  TTSOptions,
  'language' | 'voice' | 'baseURL' | 'generationTimeoutMs' | 'downloadTimeoutMs'
> = {
  language: 'am',
  voice: DEFAULT_VOICE,
  baseURL: API_BASE_URL,
  generationTimeoutMs: 95_000,
  downloadTimeoutMs: 30_000,
};

/**
 * Non-streaming text-to-speech using Addis Voices 2.
 *
 * @public
 */
export class TTS extends tts.TTS {
  readonly label = 'addisai.TTS';
  #opts: ResolvedTTSOptions;
  #abortController = new AbortController();

  constructor(opts: Partial<TTSOptions> = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: false });

    const apiKey = opts.apiKey ?? process.env.ADDIS_API_KEY;
    if (!apiKey) {
      throw new Error('AddisAI API key is required, either as `apiKey` or via ADDIS_API_KEY');
    }

    const voice = opts.voice ?? DEFAULT_OPTIONS.voice;
    if (!voice) throw new Error('voice must not be empty');

    const generationTimeoutMs = opts.generationTimeoutMs ?? DEFAULT_OPTIONS.generationTimeoutMs;
    const downloadTimeoutMs = opts.downloadTimeoutMs ?? DEFAULT_OPTIONS.downloadTimeoutMs;
    if (generationTimeoutMs <= 0 || downloadTimeoutMs <= 0) {
      throw new Error('generationTimeoutMs and downloadTimeoutMs must be positive');
    }

    this.#opts = {
      language: validateLanguage(opts.language ?? DEFAULT_OPTIONS.language),
      voice,
      speed: opts.speed,
      apiKey,
      baseURL: (opts.baseURL ?? DEFAULT_OPTIONS.baseURL).replace(/\/+$/, ''),
      generationTimeoutMs,
      downloadTimeoutMs,
    };
  }

  get model(): string {
    return 'addis-voices-2';
  }

  get provider(): string {
    return 'AddisAI';
  }

  /** Update synthesis settings used by subsequent requests. */
  updateOptions(opts: {
    language?: Language | string;
    voice?: string;
    speed?: number | null;
  }): void {
    if (opts.language !== undefined) {
      this.#opts.language = validateLanguage(opts.language);
    }
    if (opts.voice !== undefined) {
      if (!opts.voice) throw new Error('voice must not be empty');
      this.#opts.voice = opts.voice;
    }
    if (opts.speed !== undefined) {
      this.#opts.speed = opts.speed ?? undefined;
    }
  }

  synthesize(
    text: string,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, this.#abortController.signal])
      : this.#abortController.signal;
    return new ChunkedStream(this, text, { ...this.#opts }, connOptions, signal);
  }

  stream(): tts.SynthesizeStream {
    throw new APIConnectionError({
      message: 'Streaming is not supported by Addis Voices 2',
      options: { retryable: false },
    });
  }

  async close(): Promise<void> {
    this.#abortController.abort();
  }
}

/**
 * Stream for one complete Addis Voices 2 generation.
 *
 * @public
 */
export class ChunkedStream extends tts.ChunkedStream {
  readonly label = 'addisai.ChunkedStream';
  #opts: ResolvedTTSOptions;
  #clientRequestId = randomUUID();

  /** @internal */
  constructor(
    ttsInstance: TTS,
    text: string,
    opts: TTSOptions & { apiKey: string; language: Language },
    connOptions: APIConnectOptions,
    abortSignal: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    try {
      const body: Record<string, unknown> = {
        text: this.inputText,
        voice_id: this.#opts.voice,
        language: this.#opts.language,
        output_format: 'pcm_16000',
        client_request_id: this.#clientRequestId,
      };
      if (this.#opts.speed !== undefined) {
        body.voice_settings = { speed: this.#opts.speed };
      }

      const generationResponse = await fetch(`${this.#opts.baseURL}/api/v1/voice/generations`, {
        method: 'POST',
        headers: {
          'x-api-key': this.#opts.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Addis-Client': `@livekit/agents-plugin-addisai/${__PACKAGE_VERSION__}`,
        },
        body: JSON.stringify(body),
        signal: timedSignal(this.abortSignal, this.#opts.generationTimeoutMs),
      });

      const payload = await parseJsonResponse(generationResponse);
      const data = unwrapData(payload);
      const playback = isRecord(data.playback) ? data.playback : undefined;
      const audioURLValue = data.audio_url ?? data.audio_data_url ?? playback?.url;
      if (typeof audioURLValue !== 'string' || !audioURLValue) {
        throw new APIConnectionError({
          message: 'AddisAI TTS response did not include an audio URL',
          options: { retryable: true },
        });
      }

      const providerRequestIdValue = data.id;
      const providerRequestId =
        (typeof providerRequestIdValue === 'string' && providerRequestIdValue) ||
        responseRequestId(generationResponse) ||
        this.#clientRequestId;
      // The provider clip ID stays stable across idempotent retries. LiveKit
      // output request IDs must be unique per attempt so partial audio from a
      // failed download can be identified as stale.
      const streamRequestId = randomUUID();

      const audioResponse = await fetch(audioURLValue, {
        signal: timedSignal(this.abortSignal, this.#opts.downloadTimeoutMs),
      });
      await ensureSuccessfulResponse(audioResponse);
      const audio = new Uint8Array(await audioResponse.arrayBuffer());
      const pcm = decodePcmWav(audio, SAMPLE_RATE, NUM_CHANNELS);
      const byteStream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
      const frames = [...byteStream.write(pcm), ...byteStream.flush()].filter(
        (frame) => frame.samplesPerChannel > 0,
      );
      if (frames.length === 0) {
        throw new APIConnectionError({
          message: 'AddisAI TTS returned empty audio',
          options: { retryable: true },
        });
      }

      let lastFrame: AudioFrame | undefined;
      const emitLastFrame = (final: boolean) => {
        if (!lastFrame) return;
        this.queue.put({
          requestId: streamRequestId,
          segmentId: providerRequestId,
          frame: lastFrame,
          final,
        });
        lastFrame = undefined;
      };

      for (const frame of frames) {
        emitLastFrame(false);
        lastFrame = frame;
      }
      emitLastFrame(true);
    } catch (error) {
      if (this.abortSignal.aborted) return;
      mapFetchError(error, 'TTS');
    }
  }
}
