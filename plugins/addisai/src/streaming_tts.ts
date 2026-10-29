// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
} from '@livekit/agents';
import { randomUUID } from 'node:crypto';
import type { Language } from './models.js';
import { Mp3AudioDecoder } from './mp3.js';
import {
  API_BASE_URL,
  isRecord,
  mapFetchError,
  parseJsonResponse,
  timedSignal,
  unwrapData,
  validateLanguage,
} from './utils.js';
import { JsonMessageQueue, connectWebSocket, validateTicketURL } from './websocket.js';

const SAMPLE_RATE = 44_100;
const DEFAULT_VOICE = 'am-hamen';

/** Configuration for persistent Addis Voices 2 synthesis. @public */
export interface StreamingTTSOptions {
  language: Language | string;
  voice: string;
  apiKey?: string;
  baseURL: string;
  maxTextCharacters: number;
  maxAudioSeconds?: number;
  sessionTimeoutMs: number;
}

interface ResolvedOptions extends StreamingTTSOptions {
  language: Language;
  apiKey: string;
}

const DEFAULT_OPTIONS: Omit<ResolvedOptions, 'apiKey'> = {
  language: 'am',
  voice: DEFAULT_VOICE,
  baseURL: API_BASE_URL,
  maxTextCharacters: 5000,
  sessionTimeoutMs: 220_000,
};

/** Token-in/audio-out Addis Voices 2 WebSocket synthesis. @public */
export class StreamingTTS extends tts.TTS {
  readonly label = 'addisai.StreamingTTS';
  readonly options: ResolvedOptions;

  constructor(options: Partial<StreamingTTSOptions> = {}) {
    const resolved = { ...DEFAULT_OPTIONS, ...options };
    const apiKey = options.apiKey ?? process.env.ADDIS_API_KEY;
    if (!apiKey) {
      throw new Error('AddisAI API key is required, either as apiKey or via ADDIS_API_KEY');
    }
    if (!resolved.voice) throw new Error('voice must not be empty');
    if (resolved.maxTextCharacters < 1 || resolved.maxTextCharacters > 5000) {
      throw new Error('maxTextCharacters must be between 1 and 5000');
    }
    if (
      resolved.maxAudioSeconds !== undefined &&
      (resolved.maxAudioSeconds < 1 || resolved.maxAudioSeconds > 600)
    ) {
      throw new Error('maxAudioSeconds must be between 1 and 600');
    }
    if (resolved.sessionTimeoutMs <= 0) throw new Error('sessionTimeoutMs must be positive');
    super(SAMPLE_RATE, 1, { streaming: true });
    this.options = {
      ...resolved,
      language: validateLanguage(resolved.language),
      apiKey,
      baseURL: resolved.baseURL.replace(/\/+$/, ''),
    };
  }

  get model(): string {
    return 'addis-voices-2-realtime';
  }

  get provider(): string {
    return 'AddisAI';
  }

  updateOptions(options: { language?: Language | string; voice?: string }): void {
    if (options.language !== undefined) this.options.language = validateLanguage(options.language);
    if (options.voice !== undefined) {
      if (!options.voice) throw new Error('voice must not be empty');
      this.options.voice = options.voice;
    }
  }

  stream(options?: { connOptions?: APIConnectOptions }): StreamingSynthesizeStream {
    return new StreamingSynthesizeStream(
      this,
      { ...this.options },
      options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    );
  }

  synthesize(): tts.ChunkedStream {
    throw new APIConnectionError({
      message:
        'StreamingTTS supports token streaming only; use stream() or TTS for completed clips',
      options: { retryable: false },
    });
  }
}

/** A persistent Addis Voices 2 synthesis turn. @public */
export class StreamingSynthesizeStream extends tts.SynthesizeStream {
  readonly label = 'addisai.StreamingSynthesizeStream';
  #requestId = randomUUID();

  constructor(
    ttsInstance: StreamingTTS,
    private options: ResolvedOptions,
    connOptions: APIConnectOptions,
  ) {
    super(ttsInstance, connOptions);
  }

  protected async run(): Promise<void> {
    const body: Record<string, unknown> = {
      voice_id: this.options.voice,
      language: this.options.language,
      audio_format: 'mp3',
      max_text_characters: this.options.maxTextCharacters,
    };
    if (this.options.maxAudioSeconds !== undefined) {
      body.max_audio_seconds = this.options.maxAudioSeconds;
    }

    try {
      const response = await fetch(`${this.options.baseURL}/api/v1/realtime/sessions`, {
        method: 'POST',
        headers: {
          'x-api-key': this.options.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Addis-Client': `@livekit/agents-plugin-addisai/${__PACKAGE_VERSION__}`,
        },
        body: JSON.stringify(body),
        signal: timedSignal(this.abortSignal, this.options.sessionTimeoutMs),
      });
      const ticket = unwrapData(await parseJsonResponse(response));
      const url = validateTicketURL(ticket.websocket_url, '/api/v1/realtime/voice');
      const socket = await connectWebSocket(url, this.options.sessionTimeoutMs);
      const messages = new JsonMessageQueue(socket);
      let lastFrame: tts.SynthesizedAudio | undefined;
      const decoder = new Mp3AudioDecoder(SAMPLE_RATE, (frame) => {
        if (lastFrame) {
          this.queue.put({ ...lastFrame, final: false });
        }
        lastFrame = {
          requestId: this.#requestId,
          segmentId: this.#requestId,
          frame,
          final: false,
        };
      });
      try {
        socket.send(JSON.stringify({ type: 'session.authenticate', token: ticket.token }));
        const initial = await messages.next();
        if (initial.type !== 'session.created') {
          throw eventError(initial, this.#requestId, 'streaming voice session was not admitted');
        }

        const receive = async () => {
          while (true) {
            const event = await messages.next();
            if (event.type === 'error') throw eventError(event, this.#requestId);
            if (event.request_id !== undefined && event.request_id !== this.#requestId) continue;
            if (event.type === 'audio.delta') {
              if (event.format !== 'mp3' || typeof event.audio !== 'string') {
                throw new APIConnectionError({
                  message: 'AddisAI returned an unsupported streaming audio event',
                  options: { retryable: false },
                });
              }
              await decoder.push(Buffer.from(event.audio, 'base64'));
            } else if (event.type === 'speech.completed' || event.type === 'speech.cancelled') {
              if (isRecord(event.data) && typeof event.data.id === 'string') {
                this.noteProviderRequestId(event.data.id);
              }
              await decoder.end();
              if (lastFrame) {
                this.queue.put({ ...lastFrame, final: true });
                lastFrame = undefined;
              }
              return;
            }
          }
        };
        const receiveTask = receive();
        let committed = false;
        for await (const item of this.input) {
          if (typeof item === 'symbol') {
            if (!committed) {
              socket.send(JSON.stringify({ type: 'text.commit', request_id: this.#requestId }));
              committed = true;
            }
          } else {
            this.markStarted();
            socket.send(JSON.stringify({ type: 'text.append', text: item }));
          }
        }
        if (!committed) {
          socket.send(JSON.stringify({ type: 'text.commit', request_id: this.#requestId }));
        }
        await receiveTask;
      } finally {
        decoder.close();
        messages.close();
        socket.close();
      }
    } catch (error) {
      if (this.abortSignal.aborted) return;
      mapFetchError(error, 'streaming TTS');
    }
  }
}

function eventError(
  event: Record<string, unknown>,
  requestId: string,
  fallback = 'streaming voice returned an error',
): APIStatusError {
  const error = isRecord(event.error) ? event.error : event;
  return new APIStatusError({
    message: String(error.message ?? `AddisAI ${fallback}`),
    options: {
      statusCode: Number(error.status ?? event.status ?? 500),
      requestId: String(event.request_id ?? requestId),
      body: event,
    },
  });
}
