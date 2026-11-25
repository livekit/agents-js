// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  type AudioBuffer,
  DEFAULT_API_CONNECT_OPTIONS,
  asLanguageCode,
  mergeFrames,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import {
  API_BASE_URL,
  createWav,
  isRecord,
  mapFetchError,
  parseJsonResponse,
  timedSignal,
  unwrapData,
} from './utils.js';
import { JsonMessageQueue, connectWebSocket, validateTicketURL } from './websocket.js';

/** Addis Scribe recognition backend. @public */
export type ScribeBackend = 'standard' | 'turbo';
/** Addis Scribe partial-update interval. @public */
export type ScribeChunk = '320ms' | '1120ms';

/** Configuration for current Addis Scribe file and live transcription. @public */
export interface ScribeSTTOptions {
  backend: ScribeBackend;
  chunk: ScribeChunk;
  speakers: boolean;
  apiKey?: string;
  baseURL: string;
  requestTimeoutMs: number;
}

interface ResolvedOptions extends ScribeSTTOptions {
  apiKey: string;
}

const DEFAULT_OPTIONS: Omit<ResolvedOptions, 'apiKey'> = {
  backend: 'standard',
  chunk: '320ms',
  speakers: false,
  baseURL: API_BASE_URL,
  requestTimeoutMs: 600_000,
};

/** Addis Scribe file and live Amharic transcription. @public */
export class ScribeSTT extends stt.STT {
  readonly label = 'addisai.ScribeSTT';
  readonly options: ResolvedOptions;

  constructor(options: Partial<ScribeSTTOptions> = {}) {
    const resolved = { ...DEFAULT_OPTIONS, ...options };
    if (resolved.backend !== 'standard' && resolved.backend !== 'turbo') {
      throw new Error('backend must be "standard" or "turbo"');
    }
    if (resolved.chunk !== '320ms' && resolved.chunk !== '1120ms') {
      throw new Error('chunk must be "320ms" or "1120ms"');
    }
    if (resolved.speakers && resolved.backend !== 'turbo') {
      throw new Error('speaker labels require backend="turbo"');
    }
    if (resolved.requestTimeoutMs <= 0) throw new Error('requestTimeoutMs must be positive');
    const apiKey = options.apiKey ?? process.env.ADDIS_API_KEY;
    if (!apiKey) {
      throw new Error('AddisAI API key is required, either as apiKey or via ADDIS_API_KEY');
    }
    super({
      streaming: true,
      interimResults: true,
      diarization: resolved.speakers,
      alignedTranscript: false,
    });
    this.options = {
      ...resolved,
      apiKey,
      baseURL: resolved.baseURL.replace(/\/+$/, ''),
    };
  }

  get model(): string {
    return `scribe-${this.options.backend}`;
  }

  get provider(): string {
    return 'AddisAI';
  }

  protected async _recognize(
    buffer: AudioBuffer,
    abortSignal: AbortSignal = new AbortController().signal,
  ): Promise<stt.SpeechEvent> {
    const requestId = randomUUID();
    const frame = mergeFrames(buffer);
    const wav = createWav(frame);
    const form = new FormData();
    form.append(
      'audio',
      new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer], {
        type: 'audio/wav',
      }),
      'audio.wav',
    );
    const query = new URLSearchParams({
      backend: this.options.backend,
      chunk: this.options.chunk,
      request_id: requestId,
      stream: 'false',
    });
    if (this.options.speakers) query.set('speakers', 'true');

    try {
      const response = await fetch(
        `${this.options.baseURL}/api/v1/scribe/transcribe?${query.toString()}`,
        {
          method: 'POST',
          headers: this.headers,
          body: form,
          signal: timedSignal(abortSignal, this.options.requestTimeoutMs),
        },
      );
      const data = settledCompletion(unwrapData(await parseJsonResponse(response)));
      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId,
        alternatives: [
          {
            text: String(data.text),
            language: asLanguageCode('am'),
            startTime: 0,
            endTime: frame.samplesPerChannel / frame.sampleRate,
            confidence: 0,
            metadata: { usage: data.usage, scribe: data },
          },
        ],
      };
    } catch (error) {
      mapFetchError(error, 'Scribe');
    }
  }

  stream(options?: { connOptions?: APIConnectOptions }): ScribeSpeechStream {
    return new ScribeSpeechStream(this, options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS);
  }

  get headers(): Record<string, string> {
    return {
      'x-api-key': this.options.apiKey,
      Accept: 'application/json',
      'X-Addis-Client': `@livekit/agents-plugin-addisai/${__PACKAGE_VERSION__}`,
    };
  }
}

/** A live Addis Scribe recognition stream. @public */
export class ScribeSpeechStream extends stt.SpeechStream {
  readonly label = 'addisai.ScribeSpeechStream';

  constructor(
    private recognizer: ScribeSTT,
    connOptions: APIConnectOptions,
  ) {
    super(recognizer, 16_000, connOptions);
  }

  protected async run(): Promise<void> {
    const input = this.input[Symbol.asyncIterator]();
    while (!this.abortSignal.aborted) {
      const next = await input.next();
      if (next.done) return;
      if (typeof next.value === 'symbol') continue;
      await this.runSegment(next.value, input);
    }
  }

  private async runSegment(
    first: AudioFrame,
    input: AsyncIterator<AudioFrame | symbol>,
  ): Promise<void> {
    const requestId = randomUUID();
    const body: Record<string, unknown> = {
      backend: this.recognizer.options.backend,
      chunk: this.recognizer.options.chunk,
      request_id: requestId,
    };
    if (this.recognizer.options.speakers) body.speakers = true;

    try {
      const response = await fetch(`${this.recognizer.options.baseURL}/api/v1/scribe/sessions`, {
        method: 'POST',
        headers: { ...this.recognizer.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: timedSignal(this.abortSignal, this.recognizer.options.requestTimeoutMs),
      });
      const ticket = unwrapData(await parseJsonResponse(response));
      const url = validateTicketURL(ticket.websocket_url, '/api/v1/scribe/stream');
      const socket = await connectWebSocket(url, this.recognizer.options.requestTimeoutMs);
      const messages = new JsonMessageQueue(socket);
      try {
        socket.send(JSON.stringify({ type: 'session.authenticate', token: ticket.token }));
        const initial = await messages.next();
        if (initial.type === 'transcript.completed') {
          this.emitEvent(initial, requestId);
          return;
        }
        if (initial.type !== 'session.created') {
          throw new APIConnectionError({
            message: 'Addis Scribe session was not admitted',
            options: { retryable: false },
          });
        }

        const send = async () => {
          socket.send(frameBytes(first));
          while (true) {
            const next = await input.next();
            if (next.done || typeof next.value === 'symbol') break;
            socket.send(frameBytes(next.value));
          }
          socket.send(JSON.stringify({ type: 'audio.finish' }));
        };
        const receive = async () => {
          while (true) {
            const event = await messages.next();
            this.emitEvent(event, requestId);
            if (event.type === 'transcript.completed') return;
          }
        };
        await Promise.all([send(), receive()]);
      } finally {
        messages.close();
        socket.close();
      }
    } catch (error) {
      mapFetchError(error, 'Scribe live');
    }
  }

  private emitEvent(event: Record<string, unknown>, requestId: string): void {
    if (event.type === 'error') throw eventError(event, requestId);
    if (event.type === 'transcript.partial') {
      const text = event.uncommitted ?? event.text;
      if (typeof text === 'string' && text) {
        this.queue.put({
          type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
          requestId,
          alternatives: [
            { text, language: asLanguageCode('am'), startTime: 0, endTime: 0, confidence: 0 },
          ],
        });
      }
      return;
    }
    if (event.type === 'transcript.completed') {
      const data = settledCompletion(event.data);
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId,
        alternatives: [
          {
            text: String(data.text),
            language: asLanguageCode('am'),
            startTime: 0,
            endTime: 0,
            confidence: 0,
            metadata: { usage: data.usage, scribe: data },
          },
        ],
      });
    }
  }
}

function frameBytes(frame: AudioFrame): Buffer {
  return Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
}

function settledCompletion(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.text !== 'string' || !isRecord(value.usage)) {
    throw new APIConnectionError({
      message: 'Addis Scribe returned an invalid completion',
      options: { retryable: false },
    });
  }
  if (value.usage.settled !== true) {
    throw new APIConnectionError({
      message: 'Addis Scribe ended without settled billing; recover the same request ID',
      options: { retryable: false },
    });
  }
  return value;
}

function eventError(event: Record<string, unknown>, requestId: string): APIStatusError {
  const error = isRecord(event.error) ? event.error : event;
  return new APIStatusError({
    message: String(error.message ?? 'Addis Scribe returned an error'),
    options: {
      statusCode: Number(error.status ?? event.status ?? 500),
      requestId,
      body: event,
    },
  });
}
