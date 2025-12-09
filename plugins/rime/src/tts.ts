// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, AudioByteStream, shortuuid, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { DefaultLanguages, TTSModels } from './models.js';

const RIME_BASE_URL = 'https://users.rime.ai/v1/rime-tts';
const RIME_TTS_SAMPLE_RATE = 24000;
const RIME_TTS_CHANNELS = 1;

/**
 * Get the appropriate sample rate based on TTS options.
 *
 * @param opts - Optional TTS configuration options
 * @returns The sample rate in Hz. Returns the explicit samplingRate if provided,
 *          otherwise returns model-specific defaults (24000 for arcana, 16000 for mistv2,
 *          or the default RIME_TTS_SAMPLE_RATE for other models)
 */
function getSampleRate(opts?: Partial<TTSOptions>): number {
  if (opts?.samplingRate && typeof opts.samplingRate === 'number') {
    return opts.samplingRate;
  }
  switch (opts?.modelId) {
    case 'arcana':
      return 24000;
    case 'mistv2':
      return 16000;
    default:
      return RIME_TTS_SAMPLE_RATE;
  }
}

/** Configuration options for Rime AI TTS */
export interface TTSOptions {
  speaker: string;
  modelId: TTSModels | string;
  baseURL?: string;
  apiKey?: string;
  lang?: DefaultLanguages | string;
  repetition_penalty?: number;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  samplingRate?: number;
  speedAlpha?: number;
  pauseBetweenBrackets?: boolean;
  phonemizeBetweenBrackets?: boolean;
  inlineSpeedAlpha?: string;
  noTextNormalization?: boolean;
  saveOovs?: boolean;
  /** Additional Rime API parameters */
  [key: string]: string | number | boolean | undefined;
}

const defaultTTSOptions: TTSOptions = {
  modelId: 'arcana',
  speaker: 'luna',
  apiKey: process.env.RIME_API_KEY,
  baseURL: RIME_BASE_URL,
};

export class TTS extends tts.TTS {
  private opts: TTSOptions;
  label = 'rime.TTS';

  /**
   * Create a new instance of Rime TTS.
   *
   * @remarks
   * `apiKey` must be set to your Rime AI API key, either using the argument or by setting the
   * `RIME_API_KEY` environmental variable.
   *
   * @param opts - Configuration options for the TTS instance
   */

  constructor(opts: Partial<TTSOptions> = defaultTTSOptions) {
    const sampleRate = getSampleRate(opts);
    super(sampleRate, RIME_TTS_CHANNELS, {
      streaming: false,
    });

    this.opts = { ...defaultTTSOptions, ...opts };
    if (this.opts.apiKey === undefined) {
      throw new Error('RIME API key is required, whether as an argument or as $RIME_API_KEY');
    }
  }

  /**
   * Update TTS options after initialization
   *
   * @param opts - Partial options to update
   */
  updateOptions(opts: Partial<TTSOptions>) {
    this.opts = { ...this.opts, ...opts };
  }

  /**
   * Synthesize text to audio using Rime AI TTS.
   *
   * @param text - Text to synthesize
   * @returns A chunked stream of synthesized audio
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, this.opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on RimeTTS');
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'rime-tts.ChunkedStream';
  private opts: TTSOptions;
  private text: string;

  /**
   * Create a new ChunkedStream instance.
   *
   * @param tts - The parent TTS instance
   * @param text - Text to synthesize
   * @param opts - TTS configuration options
   * @param connOptions - API connection options
   * @param abortSignal - Abort signal for cancellation
   */
  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.text = text;
    this.opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const response = await fetch(`${this.opts.baseURL}`, {
      method: 'POST',
      headers: {
        Accept: 'audio/pcm',
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...Object.fromEntries(
          Object.entries(this.opts).filter(([k]) => !['apiKey', 'baseURL'].includes(k)),
        ),
        text: this.text,
      }),
      signal: this.abortSignal,
    });

    if (!response.ok) {
      throw new Error(`Rime AI TTS request failed: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const sampleRate = getSampleRate(this.opts);
    const audioByteStream = new AudioByteStream(sampleRate, RIME_TTS_CHANNELS);
    const frames = audioByteStream.write(buffer);
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
