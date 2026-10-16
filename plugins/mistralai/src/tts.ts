// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { Mistral } from '@mistralai/mistralai';
import type { MistralTTSModels, MistralTTSVoices } from './models.js';

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const DEFAULT_MODEL: MistralTTSModels = 'voxtral-mini-tts-latest';
const DEFAULT_VOICE: MistralTTSVoices = 'en_paul_neutral';

function base64ToUint8Array(base64: string): Uint8Array {
  const buf = Buffer.from(base64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Convert float32 little-endian PCM (from Mistral API) to int16 little-endian PCM. */
function f32leToS16le(data: Uint8Array): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numSamples = Math.floor(data.byteLength / 4);
  const out = new DataView(new ArrayBuffer(numSamples * 2));
  for (let i = 0; i < numSamples; i++) {
    const f = view.getFloat32(i * 4, true);
    const s = Math.max(-32768, Math.min(32767, Math.round(f * 32767)));
    out.setInt16(i * 2, s, true);
  }
  return new Uint8Array(out.buffer);
}

export interface TTSOptions {
  model: MistralTTSModels | string;
  voice?: MistralTTSVoices | string;
  refAudio?: string;
  apiKey?: string;
  client?: Mistral;
}

export class TTS extends tts.TTS {
  #opts: { model: string; voice?: string; refAudio?: string };
  #client: Mistral;
  label = 'mistral.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: false });

    if (opts.voice && opts.refAudio) {
      throw new Error("Only one of 'voice' or 'refAudio' may be provided, not both");
    }

    const apiKey = opts.apiKey ?? process.env.MISTRAL_API_KEY;
    if (!apiKey && !opts.client) {
      throw new Error(
        'Mistral API key is required, either as an argument or via MISTRAL_API_KEY env var',
      );
    }

    this.#opts = {
      model: opts.model ?? DEFAULT_MODEL,
      voice: opts.refAudio ? undefined : opts.voice ?? DEFAULT_VOICE,
      refAudio: opts.refAudio,
    };
    this.#client = opts.client ?? new Mistral({ apiKey });
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'api.mistral.ai';
  }

  updateOptions(opts: {
    model?: MistralTTSModels | string;
    voice?: MistralTTSVoices | string;
    refAudio?: string;
  }) {
    if (opts.voice && opts.refAudio) {
      throw new Error("Only one of 'voice' or 'refAudio' may be provided, not both");
    }
    if (opts.model !== undefined) this.#opts.model = opts.model;
    if (opts.voice !== undefined) {
      this.#opts.voice = opts.voice;
      this.#opts.refAudio = undefined;
    }
    if (opts.refAudio !== undefined) {
      this.#opts.refAudio = opts.refAudio;
      this.#opts.voice = undefined;
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, this.#client, this.#opts, text, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Mistral TTS');
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'mistral.ChunkedStream';
  #client: Mistral;
  #opts: { model: string; voice?: string; refAudio?: string };

  constructor(
    ttsInstance: TTS,
    client: Mistral,
    opts: { model: string; voice?: string; refAudio?: string },
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions ?? DEFAULT_API_CONNECT_OPTIONS, abortSignal);
    this.#client = client;
    this.#opts = { ...opts };
  }

  protected async run() {
    try {
      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const speechRequest: any = {
        model: this.#opts.model,
        input: this.inputText,
        responseFormat: 'pcm',
        stream: true,
      };

      if (this.#opts.refAudio) {
        speechRequest.refAudio = this.#opts.refAudio;
      } else {
        speechRequest.voiceId = this.#opts.voice ?? DEFAULT_VOICE;
      }

      const stream = await this.#client.audio.speech.complete(speechRequest, {
        fetchOptions: { signal: this.abortController.signal },
      });

      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const ev of stream as any) {
        if (this.abortController.signal.aborted) break;

        const data = ev.data ?? ev;
        const eventType = data.type ?? ev.event;

        if (eventType === 'speech.audio.delta' && data.audioData) {
          const audioBytes = f32leToS16le(base64ToUint8Array(data.audioData));

          const frames = audioByteStream.write(audioBytes);
          for (const frame of frames) {
            sendLastFrame(requestId, false);
            lastFrame = frame;
          }
        } else if (eventType === 'speech.audio.done' && data.usage) {
          this.setTokenUsage({
            inputTokens: data.usage.promptTokens ?? 0,
            outputTokens: data.usage.completionTokens ?? 0,
          });
        }
      }

      // Flush remaining audio
      const remaining = audioByteStream.flush();
      for (const frame of remaining) {
        sendLastFrame(requestId, false);
        lastFrame = frame;
      }
      sendLastFrame(requestId, true);
    } catch (error: unknown) {
      if (this.abortController.signal.aborted) return;

      if (error instanceof APIStatusError || error instanceof APIConnectionError) {
        throw error;
      }

      const err = error as { statusCode?: number; status?: number; message?: string };
      const statusCode = err.statusCode ?? err.status;

      if (statusCode !== undefined) {
        if (statusCode === 429) {
          throw new APIStatusError({
            message: `Mistral TTS: rate limit error - ${err.message ?? 'unknown error'}`,
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
        message: `Mistral TTS: connection error - ${err.message ?? 'unknown error'}`,
        options: { retryable: true },
      });
    }
  }
}
