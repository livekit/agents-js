// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SynthesizeSpeechCommandInput } from '@aws-sdk/client-polly';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import {
  type APIConnectOptions,
  APITimeoutError,
  AudioByteStream,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { TTSLanguage, TTSSpeechEngine, TTSTextType } from './models.js';
import { type AwsCredentials, resolveRegion, stripUndefined, toAwsApiError } from './utils.js';

/** Amazon Polly only returns PCM (16-bit little-endian, mono) at these sample rates. */
const SUPPORTED_PCM_SAMPLE_RATES = [8000, 16000];

export interface TTSOptions {
  voice: string;
  speechEngine: TTSSpeechEngine;
  textType: TTSTextType;
  language?: TTSLanguage | string;
  sampleRate: number;
  region?: string;
  credentials?: AwsCredentials;
  client?: PollyClient;
}

const defaultTTSOptions: Omit<TTSOptions, 'sampleRate'> = {
  voice: 'Ruth',
  speechEngine: 'generative',
  textType: 'text',
};

/**
 * Amazon Polly TTS.
 *
 * @remarks
 * Audio is requested as raw PCM (16-bit little-endian, mono) since the framework has no mp3
 * decoder. Amazon Polly only supports PCM output at 8000 Hz or 16000 Hz, so `sampleRate` is
 * restricted to those two values.
 */
export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #client: PollyClient;
  label = 'aws.TTS';
  private abortController = new AbortController();

  get model(): string {
    return this.#opts.speechEngine;
  }

  get provider(): string {
    return 'Amazon Polly';
  }

  /**
   * Create a new instance of AWS Polly TTS.
   *
   * @remarks
   * Credentials are resolved via the AWS SDK v3 default credential chain (environment
   * variables, shared config/credentials files, IMDS, etc.) unless `credentials` is provided
   * explicitly. The region is resolved from `region`, then `AWS_REGION`, then
   * `AWS_DEFAULT_REGION`, falling back to `us-east-1`.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    const sampleRate = opts.sampleRate ?? 16000;
    if (!SUPPORTED_PCM_SAMPLE_RATES.includes(sampleRate)) {
      throw new Error(
        `AWS Polly TTS only supports PCM output at ${SUPPORTED_PCM_SAMPLE_RATES.join(' or ')} Hz sample rates, got ${sampleRate}`,
      );
    }

    super(sampleRate, 1, { streaming: false });

    this.#opts = {
      ...defaultTTSOptions,
      ...opts,
      sampleRate,
    };

    this.#client =
      opts.client ??
      new PollyClient({
        region: resolveRegion(opts.region),
        credentials: opts.credentials,
        maxAttempts: 1,
      });
  }

  updateOptions(opts: {
    voice?: string;
    language?: TTSLanguage | string;
    speechEngine?: TTSSpeechEngine;
    textType?: TTSTextType;
  }) {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, this.abortController.signal])
      : this.abortController.signal;
    return new ChunkedStream(this, text, this.#client, this.#opts, connOptions, signal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on AWS Polly TTS');
  }

  async close(): Promise<void> {
    this.abortController.abort();
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'aws.ChunkedStream';
  #client: PollyClient;
  #opts: TTSOptions;

  constructor(
    tts: TTS,
    text: string,
    client: PollyClient,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#client = client;
    this.#opts = opts;
  }

  protected async run() {
    try {
      const input = stripUndefined({
        Text: this.inputText,
        OutputFormat: 'pcm',
        Engine: this.#opts.speechEngine,
        VoiceId: this.#opts.voice,
        TextType: this.#opts.textType,
        SampleRate: String(this.#opts.sampleRate),
        LanguageCode: this.#opts.language,
      }) as unknown as SynthesizeSpeechCommandInput;

      const response = await this.#client.send(new SynthesizeSpeechCommand(input), {
        abortSignal: this.abortSignal,
      });

      if (!response.AudioStream) {
        throw new Error('aws polly tts: no AudioStream in the response');
      }

      const requestId = response.$metadata.requestId ?? shortuuid();
      const audioBytes = await response.AudioStream.transformToByteArray();
      const audioByteStream = new AudioByteStream(this.#opts.sampleRate, 1);

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      // write() only emits complete 100ms frames; flush() drains the trailing remainder (up
      // to 100ms), otherwise the tail of the synthesized audio is silently dropped. flush()
      // always returns one frame even with nothing buffered (0 samples), so drop it rather
      // than let it become the "final" frame in place of the real last frame from write().
      const frames = audioByteStream.write(audioBytes);
      const remainder = audioByteStream.flush().filter((frame) => frame.samplesPerChannel > 0);
      for (const frame of [...frames, ...remainder]) {
        sendLastFrame(requestId, false);
        lastFrame = frame;
      }
      sendLastFrame(requestId, true);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new APITimeoutError({ message: error.message });
      }
      // Prefer APIStatusError when the SDK surfaces an HTTP status (e.g. invalid VoiceId /
      // Engine, malformed SSML) so non-retryable 4xx inputs are not retried as connection
      // failures by the base ChunkedStream.
      throw toAwsApiError(error, 'aws polly tts');
    }
  }
}
