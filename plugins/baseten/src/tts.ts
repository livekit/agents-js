// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, shortuuid, tts } from '@livekit/agents';
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
  synthesize(text: string): ChunkedStream {
    return new ChunkedStream(this, text, this.opts);
  }

  /**
   * Create a new streaming session for text-to-speech synthesis.
   *
   * Note: For Baseten, `synthesize()` is the recommended method as it already
   * streams audio chunks as they're generated. The `stream()` method is provided
   * for compatibility with the LiveKit TTS interface but works similarly.
   */
  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.opts);
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

  constructor(tts: TTS, text: string, opts: BasetenTTSOptions) {
    super(text, tts);
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

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();

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

/**
 * Streaming implementation for real-time TTS synthesis.
 * This class extends `tts.SynthesizeStream` to provide streaming audio synthesis.
 *
 * For Baseten, text streaming isn't needed (we have all text upfront), but we provide
 * this for compatibility with the LiveKit TTS interface. It internally uses the same
 * streaming audio approach as ChunkedStream.
 */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'baseten.SynthesizeStream';
  private readonly basetenTTS: TTS;
  private readonly opts: BasetenTTSOptions;
  private pendingStreams: Promise<void>[] = [];
  private isFlushed = false;

  constructor(tts: TTS, opts: BasetenTTSOptions) {
    super(tts);
    this.basetenTTS = tts;
    this.opts = opts;
  }

  /**
   * This method is called by the base class when iteration starts.
   * It waits for all pending text synthesis operations to complete.
   */
  protected async run(): Promise<void> {
    // Wait for flush to be called
    while (!this.isFlushed) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Wait for all pending streams to complete
    await Promise.all(this.pendingStreams);
  }

  /**
   * Push text to be synthesized. The text will be sent to the Baseten model
   * and audio chunks will be streamed back as they are generated.
   */
  async pushText(text: string): Promise<void> {
    if (!text.trim()) {
      return;
    }

    // Create a promise for this synthesis operation
    const streamPromise = (async () => {
      try {
        // Use the existing ChunkedStream implementation which already streams audio properly
        const chunkedStream = new ChunkedStream(this.basetenTTS, text, this.opts);

        // Forward all audio events from the ChunkedStream to our queue
        for await (const event of chunkedStream) {
          if (!this.isFlushed) {
            this.queue.put(event);
          }
        }
      } catch (error) {
        // Only throw if we haven't been flushed yet
        if (!this.isFlushed) {
          throw error;
        }
      }
    })();

    this.pendingStreams.push(streamPromise);
  }

  /**
   * Flush any remaining audio data and close the stream.
   */
  async flush(): Promise<void> {
    this.isFlushed = true;

    // Wait for all pending streams to complete
    await Promise.all(this.pendingStreams);

    this.queue.close();
  }
}
