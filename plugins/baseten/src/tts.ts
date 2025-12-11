// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AudioByteStream,
  shortuuid,
  tts,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { BasetenTTSOptions } from './types.js';

const defaultTTSOptions: Partial<BasetenTTSOptions> = {
  voice: 'tara',
  language: 'en',
  temperature: 0.6,
};

/**
 * Baseten TTS implementation (streaming, 24kHz mono)
 */
export class TTS extends tts.TTS {
  private opts: BasetenTTSOptions;
  label = 'baseten.TTS';
  private abortController = new AbortController();
  constructor(opts: Partial<BasetenTTSOptions> = {}) {
    /**
     * Baseten audio is 24kHz mono.
     * The Orpheus model generates audio chunks that are processed as they arrive,
     * which reduces latency and improves agent responsiveness.
     */
    super(24000, 1, { streaming: false });

    // Apply defaults and environment fallbacks.
    const apiKey = opts.apiKey ?? process.env.BASETEN_API_KEY;
    const modelEndpoint = opts.modelEndpoint ?? process.env.BASETEN_MODEL_ENDPOINT;

    if (!apiKey) {
      throw new Error(
        'Baseten API key is required, either pass it as `apiKey` or set $BASETEN_API_KEY',
      );
    }
    if (!modelEndpoint) {
      throw new Error(
        'Baseten model endpoint is required, either pass it as `modelEndpoint` or set $BASETEN_MODEL_ENDPOINT',
      );
    }

    this.opts = {
      ...defaultTTSOptions,
      ...opts,
      apiKey,
      modelEndpoint,
    } as BasetenTTSOptions;
  }

  updateOptions(opts: Partial<Omit<BasetenTTSOptions, 'apiKey' | 'modelEndpoint'>>) {
    this.opts = {
      ...this.opts,
      ...opts,
    } as BasetenTTSOptions;
  }

  /**
   * Synthesize speech for a given piece of text.  Returns a `ChunkedStream`
   * which will asynchronously fetch audio from Baseten and push frames into
   * LiveKit's playback pipeline.  If you need to cancel synthesis you can
   * call {@link ChunkedStream.stop} on the returned object.
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, this.opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Baseten TTS');
  }

  async close(): Promise<void> {
    this.abortController.abort();
  }
}

/**
 * Internal helper that performs the actual HTTP request and converts the
 * response into audio frames.  It inherits from `tts.ChunkedStream` to
 * integrate with LiveKit's event and cancellation framework.
 *
 * This implementation streams audio chunks as they arrive from the Baseten
 * model endpoint, processing them incrementally instead of waiting for the
 * complete response.
 */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'baseten.ChunkedStream';
  private readonly opts: BasetenTTSOptions;

  constructor(
    tts: TTS,
    text: string,
    opts: BasetenTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.opts = opts;
  }

  /**
   * Execute the synthesis request.  This method is automatically invoked
   * by the base class when the stream starts.  It performs a POST request
   * to the configured `modelEndpoint` with the input text and optional
   * parameters.  Audio chunks are streamed as they arrive and transformed
   * into a sequence of `AudioFrame` objects that are enqueued immediately
   * for playback.
   */
  protected async run() {
    const { apiKey, modelEndpoint, voice, language, temperature, maxTokens } = this.opts;
    const payload: Record<string, unknown> = {
      prompt: this.inputText,
    };
    if (voice) payload.voice = voice;
    if (language) payload.language = language;
    if (temperature !== undefined) payload.temperature = temperature;
    if (maxTokens !== undefined) payload.max_tokens = maxTokens;

    const headers: Record<string, string> = {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(modelEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: this.abortSignal,
    });

    if (!response.ok) {
      let errText: string;
      try {
        errText = await response.text();
      } catch {
        errText = response.statusText;
      }
      throw new Error(`Baseten TTS request failed: ${response.status} ${errText}`);
    }

    // Stream the response body as chunks arrive
    if (!response.body) {
      throw new Error('Response body is not available for streaming');
    }

    const requestId = shortuuid();
    const audioByteStream = new AudioByteStream(24000, 1);
    const reader = response.body.getReader();

    try {
      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      // waitForAbort internally sets up an abort listener on the abort signal
      // we need to put it outside loop to avoid constant re-registration of the listener
      const abortPromise = waitForAbort(this.abortSignal);

      while (!this.abortSignal.aborted) {
        const result = await Promise.race([reader.read(), abortPromise]);

        if (result === undefined) break; // aborted

        const { done, value } = result;

        if (done) {
          break;
        }

        // Process the chunk and convert to audio frames
        // Convert Uint8Array to ArrayBuffer for AudioByteStream
        const frames = audioByteStream.write(value.buffer);

        for (const frame of frames) {
          sendLastFrame(requestId, false);
          lastFrame = frame;
        }
      }

      // Send the final frame
      sendLastFrame(requestId, true);
    } finally {
      reader.releaseLock();
      this.queue.close();
    }
  }
}
