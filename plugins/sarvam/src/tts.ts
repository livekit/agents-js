// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, AudioByteStream, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { TTSLanguages, TTSModels, TTSSpeakers } from './models.js';

const SARVAM_TTS_SAMPLE_RATE = 24000;
const SARVAM_TTS_CHANNELS = 1;
const SARVAM_BASE_URL = 'https://api.sarvam.ai';

/** Configuration options for Sarvam AI TTS */
export interface TTSOptions {
  /** Sarvam API key. Defaults to $SARVAM_API_KEY */
  apiKey?: string;
  /** TTS model to use */
  model: TTSModels | string;
  /** Speaker voice */
  speaker: TTSSpeakers | string;
  /** Target language code (BCP-47) */
  targetLanguageCode: TTSLanguages | string;
  /** Pitch adjustment, -0.75 to 0.75 (bulbul:v2 only) */
  pitch?: number;
  /** Speech pace, 0.5 to 2.0 */
  pace?: number;
  /** Loudness, 0.3 to 3.0 (bulbul:v2 only) */
  loudness?: number;
  /** Output sample rate in Hz */
  sampleRate?: number;
  /** Enable text preprocessing (bulbul:v2 only) */
  enablePreprocessing?: boolean;
  /** Base URL for the Sarvam API */
  baseURL?: string;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.SARVAM_API_KEY,
  model: 'bulbul:v2',
  speaker: 'anushka',
  targetLanguageCode: 'en-IN',
  pitch: 0,
  pace: 1.0,
  loudness: 1.0,
  sampleRate: SARVAM_TTS_SAMPLE_RATE,
  enablePreprocessing: false,
  baseURL: SARVAM_BASE_URL,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'sarvam.TTS';

  /**
   * Create a new instance of Sarvam AI TTS.
   *
   * @remarks
   * `apiKey` must be set to your Sarvam API key, either using the argument or by setting the
   * `SARVAM_API_KEY` environment variable.
   */
  constructor(opts: Partial<TTSOptions> = defaultTTSOptions) {
    const sampleRate = opts.sampleRate ?? defaultTTSOptions.sampleRate!;
    super(sampleRate, SARVAM_TTS_CHANNELS, { streaming: false });

    this.#opts = { ...defaultTTSOptions, ...opts };
    if (this.#opts.apiKey === undefined) {
      throw new Error('Sarvam API key is required, whether as an argument or as $SARVAM_API_KEY');
    }
  }

  /**
   * Update TTS options after initialization.
   *
   * @param opts - Partial options to update
   */
  updateOptions(opts: {
    model?: TTSModels | string;
    speaker?: TTSSpeakers | string;
    pace?: number;
    pitch?: number;
    loudness?: number;
  }) {
    this.#opts = { ...this.#opts, ...opts };
  }

  /**
   * Synthesize text to audio using Sarvam AI TTS.
   *
   * @param text - Text to synthesize (max 2500 chars for v3, 1500 for v2)
   * @param connOptions - API connection options
   * @param abortSignal - Abort signal for cancellation
   * @returns A chunked stream of synthesized audio
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  /** @internal Streaming is not supported by the Sarvam REST API. */
  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Sarvam TTS');
  }
}

/** Chunked stream for Sarvam AI TTS that processes a single synthesis request. */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'sarvam.ChunkedStream';
  private opts: TTSOptions;

  /** @internal */
  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const sampleRate = this.opts.sampleRate ?? SARVAM_TTS_SAMPLE_RATE;
    const baseURL = this.opts.baseURL ?? SARVAM_BASE_URL;

    const response = await fetch(`${baseURL}/text-to-speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': this.opts.apiKey!,
      },
      body: JSON.stringify({
        text: this.inputText,
        target_language_code: this.opts.targetLanguageCode,
        speaker: this.opts.speaker,
        model: this.opts.model,
        pitch: this.opts.pitch,
        pace: this.opts.pace,
        loudness: this.opts.loudness,
        speech_sample_rate: String(sampleRate),
        enable_preprocessing: this.opts.enablePreprocessing,
        output_audio_codec: 'wav',
      }),
      signal: this.abortSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Sarvam TTS API error ${response.status}: ${errorBody}`);
    }

    const data = (await response.json()) as { audios: string[] };
    const audioBase64 = data.audios[0];
    if (!audioBase64) {
      throw new Error('Sarvam TTS returned empty audio');
    }

    // Decode base64 WAV and strip 44-byte header to get raw PCM
    const raw = Buffer.from(audioBase64, 'base64');
    const pcmData = raw.buffer.slice(raw.byteOffset + 44, raw.byteOffset + raw.byteLength);

    const audioByteStream = new AudioByteStream(sampleRate, SARVAM_TTS_CHANNELS);
    const frames = [...audioByteStream.write(pcmData), ...audioByteStream.flush()];

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

    this.queue.close();
  }
}
