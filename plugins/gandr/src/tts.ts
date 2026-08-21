// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { TTSModels, TTSVoices } from './models.js';

const GANDR_SAMPLE_RATE = 24000;
const GANDR_CHANNELS = 1;
const DEFAULT_BASE_URL = 'https://tts.gandr.ai/v1';

export interface TTSOptions {
  /** Gandr `gnd_...` key. Defaults to the GANDR_API_KEY env var. */
  apiKey?: string;
  /** Model id. Accepted and routed to the Gandr engine; defaults to `tts-1`. */
  model?: TTSModels;
  /** Stock id (`gandr-mia`, ...) or any OpenAI alias or `gnd:` clone id. */
  voice?: TTSVoices;
  /** Speed 0.6 to 1.5, pitch preserving. The door clamps out-of-range. */
  speed?: number;
  /**
   * Output audio format. `pcm` (headerless) is what LiveKit consumes.
   * `wav` also works; the endpoint defaults to `mp3`, which the doors
   * deliberately do not encode, so always pass an explicit format.
   */
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  /** Base URL of the OpenAI-compatible audio shim. Defaults to tts.gandr.ai/v1. */
  baseURL?: string;
}

const defaultTTSOptions: Pick<TTSOptions, 'model' | 'voice' | 'speed' | 'responseFormat'> = {
  model: 'tts-1',
  voice: 'gandr-mia',
  speed: 1,
  responseFormat: 'pcm',
};

/**
 * Gandr TTS for LiveKit Agents.
 *
 * Speaks `POST <baseURL>/audio/speech`, the OpenAI-compatible shim Gandr
 * mounts at `/v1/audio/speech`. The plugin pins `response_format` to `pcm`
 * so the returned bytes are headerless s16le that LiveKit plays directly.
 *
 * @example
 * ```ts
 * import * as gandr from '@livekit/agents-plugin-gandr';
 *
 * const session = new voice.AgentSession({
 *   tts: new gandr.TTS({ voice: 'gandr-mia' }), // GANDR_API_KEY in env
 *   // ...
 * });
 * ```
 */
export class TTS extends tts.TTS {
  #opts: TTSOptions & { apiKey: string };

  label = 'gandr.TTS';

  private abortController = new AbortController();

  get model(): string {
    return this.#opts.model ?? 'tts-1';
  }

  get provider(): string {
    return 'gandr';
  }

  constructor(opts: TTSOptions = {}) {
    super(GANDR_SAMPLE_RATE, GANDR_CHANNELS, { streaming: false });

    const apiKey = opts.apiKey ?? process.env.GANDR_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Gandr API key is required, either pass it as `apiKey` or set $GANDR_API_KEY',
      );
    }

    this.#opts = { ...defaultTTSOptions, ...opts, apiKey };
  }

  updateOptions(opts: Pick<TTSOptions, 'model' | 'voice' | 'speed' | 'responseFormat'>) {
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
    return new ChunkedStream(this, text, this.#opts, connOptions, signal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Gandr TTS');
  }

  async close(): Promise<void> {
    this.abortController.abort();
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'gandr.ChunkedStream';

  constructor(
    tts: TTS,
    text: string,
    private readonly opts: TTSOptions & { apiKey: string },
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
  }

  protected async run() {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const { apiKey, model, voice, speed, responseFormat, baseURL } = this.opts;

      let response: Response;
      try {
        response = await fetch(`${baseURL ?? DEFAULT_BASE_URL}/audio/speech`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            input: this.inputText,
            voice,
            response_format: responseFormat ?? 'pcm',
            speed,
          }),
          signal: this.abortSignal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }
        throw new APIConnectionError({
          message: `Gandr request failed: ${String(error)}`,
        });
      }

      if (!response.ok) {
        let detail = '';
        try {
          detail = await response.text();
        } catch {
          // response body not readable; keep detail empty
        }
        throw new APIStatusError({
          message: `Gandr ${response.status}: ${detail.trim()}`,
          options: {
            statusCode: response.status,
            body: { detail },
          },
        });
      }

      if (!response.body) {
        throw new Error('Gandr response body is not available for streaming');
      }

      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(GANDR_SAMPLE_RATE, GANDR_CHANNELS);
      reader = response.body.getReader();

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      while (!this.abortSignal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        const frames = audioByteStream.write(value);
        for (const frame of frames) {
          sendLastFrame(false);
          lastFrame = frame;
        }
      }

      for (const frame of audioByteStream.flush()) {
        if (frame.samplesPerChannel === 0) continue;
        sendLastFrame(false);
        lastFrame = frame;
      }

      sendLastFrame(true);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      if (error instanceof APIStatusError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new APITimeoutError({ message: `Gandr request timed out: ${error.message}` });
      }
      throw new APIConnectionError({ message: `Gandr request failed: ${String(error)}` });
    } finally {
      try {
        await reader?.cancel();
      } catch {
        // stream already errored or closed
      }
      this.queue.close();
    }
  }
}
