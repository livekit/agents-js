// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIError,
  APIStatusError,
  AudioByteStream,
  shortuuid,
  tts,
} from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type * as speechProviders from '@speech-sdk/core/providers';
import type { ResolvedModel } from '@speech-sdk/core/types';
import type { TTSModels, TTSProviders } from './models.js';

const SPEECHSDK_TTS_CHANNELS = 1;
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_MODEL: TTSModels = 'openai/gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';

const RETRYABLE_STATUS_CODES = new Set([408, 429]);
const PCM_RATE_REGEX = /rate=(\d+)/;

type ProvidersModule = typeof speechProviders;
type SpeechModelFactory = (config: { apiKey?: string }) => (modelId: string) => ResolvedModel;

const PROVIDER_FACTORIES: Record<TTSProviders, (mod: ProvidersModule) => SpeechModelFactory> = {
  cartesia: (mod) => mod.createCartesia,
  deepgram: (mod) => mod.createDeepgram,
  elevenlabs: (mod) => mod.createElevenLabs,
  'fal-ai': (mod) => mod.createFal,
  'fish-audio': (mod) => mod.createFishAudio,
  google: (mod) => mod.createGoogle,
  hume: (mod) => mod.createHume,
  inworld: (mod) => mod.createInworld,
  minimax: (mod) => mod.createMiniMax,
  mistral: (mod) => mod.createMistral,
  murf: (mod) => mod.createMurf,
  openai: (mod) => mod.createOpenAI,
  resemble: (mod) => mod.createResemble,
  'smallest-ai': (mod) => mod.createSmallestAI,
  xai: (mod) => mod.createXai,
};

const isKnownProvider = (provider: string): provider is TTSProviders =>
  provider in PROVIDER_FACTORIES;

// fal model ids are path-style ("kokoro/american-english"), so split on the first slash only.
const parseModel = (model: string): { provider: string; modelId: string } => {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `Invalid speech-sdk model "${model}": expected a "provider/model" string, e.g. "${DEFAULT_MODEL}"`,
    );
  }
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
};

export interface TTSOptions {
  /**
   * Model as a `provider/model` string, e.g. `openai/gpt-4o-mini-tts` or
   * `elevenlabs/eleven_flash_v2_5`. The prefix selects which provider API is called.
   */
  model: TTSModels | string;
  /** Voice ID, as defined by the selected provider. */
  voice: string;
  /** Sample rate of emitted frames in Hz. Audio returned at another native rate is resampled. */
  sampleRate: number;
  /**
   * Provider API key. Defaults to the selected provider's standard environment variable
   * (e.g. `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MURF_API_KEY`).
   */
  apiKey?: string;
  /**
   * SpeechBase gateway API key, defaulting to `SPEECHBASE_API_KEY`. When set, `provider/model`
   * strings are routed through the speechbase.ai gateway with this single key; when unset,
   * calls go directly to the provider with your own key.
   */
  speechbaseApiKey?: string;
  /** Additional provider-specific request options forwarded to speech-sdk. */
  providerOptions?: Record<string, unknown>;
}

const defaultTTSOptions: TTSOptions = {
  model: DEFAULT_MODEL,
  voice: DEFAULT_VOICE,
  sampleRate: DEFAULT_SAMPLE_RATE,
  speechbaseApiKey: process.env.SPEECHBASE_API_KEY,
};

const validateModel = (opts: TTSOptions) => {
  const { provider } = parseModel(opts.model);
  if (!opts.speechbaseApiKey && !isKnownProvider(provider)) {
    throw new Error(
      `Unknown speech-sdk provider "${provider}", expected one of: ${Object.keys(PROVIDER_FACTORIES).join(', ')}`,
    );
  }
};

const resolveSpeechModel = async (opts: TTSOptions): Promise<string | ResolvedModel> => {
  if (opts.speechbaseApiKey) {
    return opts.model;
  }
  const { provider, modelId } = parseModel(opts.model);
  if (!isKnownProvider(provider)) {
    throw new Error(`Unknown speech-sdk provider "${provider}"`);
  }
  const providers = await import('@speech-sdk/core/providers');
  const factory = PROVIDER_FACTORIES[provider](providers);
  return factory(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {})(modelId);
};

const toAPIError = async (error: unknown): Promise<unknown> => {
  const { ApiError: SpeechApiError, SpeechSDKError } = await import('@speech-sdk/core');
  if (error instanceof SpeechApiError) {
    return new APIStatusError({
      message: error.message,
      options: {
        statusCode: error.statusCode,
        retryable: RETRYABLE_STATUS_CODES.has(error.statusCode) || error.statusCode >= 500,
      },
    });
  }
  if (error instanceof SpeechSDKError) {
    return new APIError(error.message, { retryable: false });
  }
  return error;
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'speechsdk.TTS';
  private abortController = new AbortController();

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return parseModel(this.#opts.model).provider;
  }

  /**
   * Create a new instance of speech-sdk TTS.
   *
   * @remarks
   * The provider's API key must be set in its standard environment variable (e.g.
   * `OPENAI_API_KEY` for `openai/...` models) or passed via the `apiKey` option.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    const merged = { ...defaultTTSOptions, ...opts };
    super(merged.sampleRate, SPEECHSDK_TTS_CHANNELS, { streaming: false });
    validateModel(merged);
    this.#opts = merged;
  }

  updateOptions(opts: { model?: TTSModels | string; voice?: string }) {
    const merged = { ...this.#opts, ...opts };
    validateModel(merged);
    this.#opts = merged;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, this.abortController.signal])
      : this.abortController.signal;
    return new ChunkedStream(this, text, this.#opts, connOptions, signal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on SpeechSDK TTS');
  }

  async close(): Promise<void> {
    this.abortController.abort();
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'speechsdk.ChunkedStream';
  #opts: TTSOptions;

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#opts = opts;
  }

  protected async run() {
    try {
      const { generateSpeech } = await import('@speech-sdk/core');
      const model = await resolveSpeechModel(this.#opts);
      // maxRetries: 0 disables speech-sdk's internal retry; the retry policy in
      // tts.ChunkedStream (connOptions) owns retries to avoid multiplying attempts.
      const result = await generateSpeech({
        model,
        text: this.inputText,
        voice: this.#opts.voice,
        output: { format: 'pcm' },
        providerOptions: this.#opts.providerOptions,
        apiKey: this.#opts.speechbaseApiKey,
        maxRetries: 0,
        abortSignal: this.abortController.signal,
      });

      const requestId = shortuuid();
      const frames = this.#toFrames(result.audio.uint8Array, result.audio.mediaType);

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      for (const frame of frames) {
        sendLastFrame(requestId, false);
        lastFrame = frame;
      }
      sendLastFrame(requestId, true);
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      throw await toAPIError(error);
    } finally {
      this.queue.close();
    }
  }

  #toFrames(pcm: Uint8Array, mediaType: string): AudioFrame[] {
    const rateMatch = PCM_RATE_REGEX.exec(mediaType);
    if (!rateMatch) {
      throw new APIError(`speech-sdk returned unexpected mediaType "${mediaType}", expected PCM`, {
        retryable: false,
      });
    }
    const nativeRate = Number(rateMatch[1]);
    const bstream = new AudioByteStream(this.#opts.sampleRate, SPEECHSDK_TTS_CHANNELS);

    if (nativeRate === this.#opts.sampleRate) {
      return [...bstream.write(pcm), ...bstream.flush()];
    }

    const aligned = pcm.byteOffset % 2 === 0 ? pcm : pcm.slice();
    const samples = new Int16Array(
      aligned.buffer,
      aligned.byteOffset,
      Math.floor(aligned.byteLength / 2),
    );
    const nativeFrame = new AudioFrame(samples, nativeRate, SPEECHSDK_TTS_CHANNELS, samples.length);
    const resampler = new AudioResampler(nativeRate, this.#opts.sampleRate, SPEECHSDK_TTS_CHANNELS);
    const frames: AudioFrame[] = [];
    try {
      for (const resampled of [...resampler.push(nativeFrame), ...resampler.flush()]) {
        frames.push(...bstream.write(resampled.data));
      }
    } finally {
      resampler.close();
    }
    frames.push(...bstream.flush());
    return frames;
  }
}
