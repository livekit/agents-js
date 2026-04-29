// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  AudioByteStream,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { TTSOptions, VoiceByName } from './models.js';
import { HumeVoiceProvider } from './models.js';

const STREAM_PATH = '/v0/tts/stream/json';
const DEFAULT_BASE_URL = 'https://api.hume.ai';
const SUPPORTED_SAMPLE_RATE = 48000;
const NUM_CHANNELS = 1;

const DEFAULT_VOICE: VoiceByName = {
  name: 'Male English Actor',
  provider: HumeVoiceProvider.Hume,
};

const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Hume-Client-Name': 'livekit',
  'X-Hume-Client-Version': '0.1.0',
};

const API_AUTH_HEADER = 'X-Hume-Api-Key';

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.HUME_API_KEY,
  baseUrl: DEFAULT_BASE_URL,
  voice: DEFAULT_VOICE,
  modelVersion: '1',
};

export class TTS extends tts.TTS {
  label = 'hume.TTS';
  #opts: Required<Pick<TTSOptions, 'apiKey' | 'baseUrl' | 'modelVersion'>> & TTSOptions;

  get model(): string {
    return 'Octave';
  }

  get provider(): string {
    return 'Hume';
  }

  /**
   * Create a new instance of Hume TTS.
   *
   * @remarks
   * `apiKey` must be set to your Hume API key, either using the argument or by setting the
   * `HUME_API_KEY` environmental variable.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    super(SUPPORTED_SAMPLE_RATE, NUM_CHANNELS, { streaming: false });

    const merged = { ...defaultTTSOptions, ...opts };
    const apiKey = merged.apiKey;
    if (!apiKey) {
      throw new Error('Hume API key is required, whether as an argument or as $HUME_API_KEY');
    }

    const voice = opts.voice ?? DEFAULT_VOICE;
    const instantMode = opts.instantMode ?? voice !== undefined;

    if (instantMode && !voice) {
      throw new Error('Hume TTS: instantMode cannot be enabled without specifying a voice');
    }

    this.#opts = {
      ...merged,
      apiKey,
      baseUrl: merged.baseUrl ?? DEFAULT_BASE_URL,
      modelVersion: merged.modelVersion ?? '1',
      voice,
      instantMode,
    };
  }

  /**
   * Update TTS options after initialization.
   *
   * @param opts - Partial options to update
   */
  updateOptions(opts: Partial<Omit<TTSOptions, 'apiKey' | 'baseUrl'>>): void {
    if (opts.description !== undefined) this.#opts.description = opts.description;
    if (opts.speed !== undefined) this.#opts.speed = opts.speed;
    if (opts.voice !== undefined) this.#opts.voice = opts.voice;
    if (opts.trailingSilence !== undefined) this.#opts.trailingSilence = opts.trailingSilence;
    if (opts.context !== undefined) this.#opts.context = opts.context;
    if (opts.instantMode !== undefined) this.#opts.instantMode = opts.instantMode;
    if (opts.modelVersion !== undefined) this.#opts.modelVersion = opts.modelVersion;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, { ...this.#opts }, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Hume TTS');
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'hume.ChunkedStream';
  #opts: Required<Pick<TTSOptions, 'apiKey' | 'baseUrl' | 'modelVersion'>> & TTSOptions;
  #text: string;

  constructor(
    ttsInstance: TTS,
    text: string,
    opts: Required<Pick<TTSOptions, 'apiKey' | 'baseUrl' | 'modelVersion'>> & TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(SUPPORTED_SAMPLE_RATE, NUM_CHANNELS);

    const utterance: Record<string, unknown> = { text: this.#text };
    if (this.#opts.voice !== undefined) utterance.voice = this.#opts.voice;
    if (this.#opts.description !== undefined) utterance.description = this.#opts.description;
    if (this.#opts.speed !== undefined) utterance.speed = this.#opts.speed;
    if (this.#opts.trailingSilence !== undefined)
      utterance.trailing_silence = this.#opts.trailingSilence;

    const payload: Record<string, unknown> = {
      utterances: [utterance],
      version: this.#opts.modelVersion,
      strip_headers: true,
      instant_mode: this.#opts.instantMode,
      format: { type: 'pcm' },
    };

    if (typeof this.#opts.context === 'string') {
      payload.context = { generation_id: this.#opts.context };
    } else if (Array.isArray(this.#opts.context)) {
      payload.context = { utterances: this.#opts.context };
    }

    const url = `${this.#opts.baseUrl}${STREAM_PATH}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          [API_AUTH_HEADER]: this.#opts.apiKey,
        },
        body: JSON.stringify(payload),
        signal: this.abortSignal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Hume TTS request failed: ${response.status} ${response.statusText} ${body}`,
        );
      }

      if (!response.body) {
        throw new Error('Hume TTS response has no body');
      }

      // Read NDJSON response line by line
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastFrame: AudioFrame | undefined;

      const sendLastFrame = (final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const data = JSON.parse(trimmed);
          if (data.type === 'error') {
            throw new Error(`Hume TTS error: ${JSON.stringify(data)}`);
          }

          const audioB64: string | undefined = data.audio;
          if (audioB64) {
            const audioBytes = Buffer.from(audioB64, 'base64');
            for (const frame of bstream.write(audioBytes)) {
              sendLastFrame(false);
              lastFrame = frame;
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const data = JSON.parse(buffer.trim());
        const audioB64: string | undefined = data.audio;
        if (audioB64) {
          const audioBytes = Buffer.from(audioB64, 'base64');
          for (const frame of bstream.write(audioBytes)) {
            sendLastFrame(false);
            lastFrame = frame;
          }
        }
      }

      // Flush remaining audio
      for (const frame of bstream.flush()) {
        sendLastFrame(false);
        lastFrame = frame;
      }
      sendLastFrame(true);

      this.queue.close();
    } catch (e) {
      if (this.abortSignal?.aborted) return;

      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      if (e instanceof APIConnectionError) {
        throw e;
      }
      throw new APIConnectionError({
        message: `Hume TTS error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}
