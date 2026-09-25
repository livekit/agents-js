// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

const DEFAULT_BASE_URL = 'https://api.bland.ai/v2';
const DEFAULT_VOICE_ID = 'f04af0e5-1a80-48a9-b02d-52f30d417cfa';
const DEFAULT_SAMPLE_RATE = 48000;
const NUM_CHANNELS = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const SAMPLE_RATES = [8000, 16000, 24000, 44100, 48000] as const;

/**
 * Configuration options for Bland TTS.
 *
 * @public
 */
export interface TTSOptions {
  /**
   * Bland voice UUID. Names are not accepted. Defaults to a BTTS_V3 voice.
   * BTTS_V2 voices work, but the controls are calibrated for BTTS_V3 and newer.
   */
  voiceId?: string;
  /** Output sample rate in Hz. Defaults to 48000, the native BTTS_V3 rate. */
  sampleRate?: number;
  /** Higher values produce more varied intonation. Range: 0.0-1.0. */
  expressiveness?: number;
  /** Higher values produce more consistency between renders. Range: 0.0-1.0. */
  stability?: number;
  /** Bland API key. Falls back to `$BLAND_API_KEY`. */
  apiKey?: string;
  /** Bland API base URL. */
  baseUrl?: string;
}

interface ResolvedTTSOptions {
  voiceId: string;
  sampleRate: number;
  expressiveness?: number;
  stability?: number;
  apiKey: string;
  baseUrl: string;
}

const resolvedOptions = new WeakMap<tts.TTS, ResolvedTTSOptions>();

function resolveOptions(opts: TTSOptions): ResolvedTTSOptions {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (!(SAMPLE_RATES as readonly number[]).includes(sampleRate)) {
    throw new Error(`sampleRate must be one of ${SAMPLE_RATES.join(', ')}, got ${sampleRate}`);
  }

  const apiKey = opts.apiKey ?? process.env.BLAND_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Bland API key is required, either as `apiKey` argument or `BLAND_API_KEY` environment variable',
    );
  }

  return {
    voiceId: opts.voiceId ?? DEFAULT_VOICE_ID,
    sampleRate,
    expressiveness: opts.expressiveness,
    stability: opts.stability,
    apiKey,
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
  };
}

/**
 * Bland text-to-speech client.
 *
 * @public
 */
export class TTS extends tts.TTS {
  label = 'bland.TTS';
  #opts: ResolvedTTSOptions;

  constructor(opts: TTSOptions = {}) {
    const resolved = resolveOptions(opts);
    super(resolved.sampleRate, NUM_CHANNELS, { streaming: false });
    this.#opts = resolved;
    resolvedOptions.set(this, resolved);
  }

  get provider(): string {
    return 'Bland';
  }

  /** Update voice and synthesis controls for subsequent requests. */
  updateOptions(opts: Partial<Pick<TTSOptions, 'voiceId' | 'expressiveness' | 'stability'>>): void {
    if (opts.voiceId !== undefined) this.#opts.voiceId = opts.voiceId;
    if (opts.expressiveness !== undefined) this.#opts.expressiveness = opts.expressiveness;
    if (opts.stability !== undefined) this.#opts.stability = opts.stability;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Bland TTS');
  }
}

/**
 * Audio stream returned by a Bland synthesis request.
 *
 * @public
 */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'bland.ChunkedStream';
  #opts: ResolvedTTSOptions;
  #text: string;
  #timeoutMs: number;

  constructor(
    ttsInstance: TTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#text = text;
    this.#opts = { ...resolvedOptions.get(ttsInstance)! };
    this.#timeoutMs = Math.min(
      connOptions?.timeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
      REQUEST_TIMEOUT_MS,
    );
  }

  protected async run(): Promise<void> {
    const controls: Record<string, number> = {};
    if (this.#opts.expressiveness !== undefined) {
      controls.expressiveness = this.#opts.expressiveness;
    }
    if (this.#opts.stability !== undefined) controls.stability = this.#opts.stability;

    const payload: Record<string, unknown> = {
      text: this.#text,
      voice: this.#opts.voiceId,
      audio: { encoding: 'pcm_s16le', sample_rate: this.#opts.sampleRate },
    };
    if (Object.keys(controls).length > 0) payload.controls = controls;

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([this.abortSignal, timeoutSignal]);

    try {
      const response = await fetch(`${this.#opts.baseUrl}/tts`, {
        method: 'POST',
        headers: {
          authorization: this.#opts.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        throw new APIStatusError({
          message: await errorMessage(response),
          options: {
            statusCode: response.status,
            requestId: response.headers.get('x-request-id'),
          },
        });
      }

      const reader = response.body?.getReader();
      if (!reader) throw new APIConnectionError({ message: 'Bland TTS response has no body' });

      const requestId = response.headers.get('x-request-id') ?? shortuuid();
      const audioStream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (final: boolean) => {
        if (!lastFrame) return;
        this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
        lastFrame = undefined;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of audioStream.write(value)) {
            sendLastFrame(false);
            lastFrame = frame;
          }
        }

        for (const frame of audioStream.flush()) {
          sendLastFrame(false);
          lastFrame = frame;
        }
        sendLastFrame(true);
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) throw error;
      if (timeoutSignal.aborted) throw new APITimeoutError({});
      throw new APIConnectionError({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function errorMessage(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return response.statusText || 'request failed';
  }

  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = payload.error;
    if (error && typeof error === 'object') {
      const code = 'code' in error ? error.code : undefined;
      const message = 'message' in error ? error.message : undefined;
      if (code && message) return `${String(code)}: ${String(message)}`;
      if (message) return String(message);
    }
  }
  return JSON.stringify(payload);
}
