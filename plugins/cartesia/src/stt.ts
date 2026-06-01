// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  AudioByteStream,
  asLanguageCode,
  calculateAudioDurationSeconds,
  log,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { AUDIO_ENCODING, type STTModel } from './models.js';

const AUTHORIZATION_HEADER = 'X-API-Key';
const VERSION_HEADER = 'Cartesia-Version';
const REQUEST_ID_HEADER = 'cartesia-request-id';
const API_VERSION = '2026-03-01';
const DRAIN_TIMEOUT_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 30000;

/**
 * Fires once when the WebSocket connection is established.
 *
 * You do not need to wait for this event before sending audio.
 */
type STTConnectedEvent = {
  type: 'connected';
  /**
   * Unique identifier for this connection. Does not change between turns.
   */
  request_id: string;
};

/**
 * Model predicts {@link stt.SpeechEventType.START_OF_SPEECH}.
 */
type STTTurnStartEvent = {
  type: 'turn.start';
  /**
   * Unique identifier for this connection. Does not change between turns.
   */
  request_id: string;
};

/**
 * Fires repeatedly as the model transcribes the current user turn.
 *
 * Can be used for {@link stt.SpeechEventType.INTERIM_TRANSCRIPT}.
 */
type STTTurnUpdateEvent = {
  type: 'turn.update';
  /**
   * Cumulative text for the current turn, i.e. the full text transcribed so far in this turn, not a delta.
   */
  transcript: string;
  /**
   * Unique identifier for this connection. Does not change between turns.
   */
  request_id: string;
};

/**
 * Fires when the model predicts that the user might be done speaking.
 *
 * Can be used for {@link stt.SpeechEventType.PREFLIGHT_TRANSCRIPT}.
 */
type STTTurnEagerEndEvent = {
  type: 'turn.eager_end';
  /**
   * Cumulative text for the current turn, i.e. the full text transcribed so far in this turn, not a delta.
   */
  transcript: string;
  /**
   * Unique identifier for this connection. Does not change between turns.
   */
  request_id: string;
};

/**
 * Fires after {@link STTTurnEagerEndEvent} if the user turn has not actually ended.
 */
type STTTurnResumeEvent = {
  type: 'turn.resume';
  /**
   * Unique identifier for this connection. Does not change between turns.
   */
  request_id: string;
};

/**
 * Marks the end of a user turn.
 *
 * This is used for {@link stt.SpeechEventType.END_OF_SPEECH} and {@link stt.SpeechEventType.FINAL_TRANSCRIPT}.
 */
type STTTurnEndEvent = {
  type: 'turn.end';
  /**
   * Cumulative text for the current turn, i.e. the full text transcribed so far in this turn, not a delta.
   */
  transcript: string;
  /**
   * Unique identifier for this connection. Does not change between turns.
   */
  request_id: string;
};

type STTErrorEvent = {
  type: 'error';
  error_code?: string;
  status_code?: number;
  title?: string;
  message?: string;
  doc_url?: string;
  request_id?: string;
};

/**
 * Server-sent event on the `/stt/turns/websocket` endpoint.
 *
 * See https://docs.cartesia.ai/api-reference/stt/turns/websocket.
 */
type STTEventMessage =
  | STTConnectedEvent
  | STTTurnStartEvent
  | STTTurnUpdateEvent
  | STTTurnEagerEndEvent
  | STTTurnResumeEvent
  | STTTurnEndEvent
  | STTErrorEvent;

export type STTOptions = {
  apiKey: string;
  // eslint-disable-next-line @typescript-eslint/ban-types
  model: STTModel | (string & {});
  sampleRate: number;
  baseUrl: string;
  audioChunkDurationMS: number;
};

const defaultSTTOptions = {
  model: 'ink-2' satisfies STTModel,
  /** recommended default */
  sampleRate: 16_000,
  /** recommended default */
  audioChunkDurationMS: 160,
  baseUrl: 'https://api.cartesia.ai',
};

function mergeSTTOptions(base: STTOptions, override: Partial<STTOptions>): STTOptions {
  return {
    apiKey: override.apiKey ?? base.apiKey,
    baseUrl: override.baseUrl ?? base.baseUrl,
    model: override.model ?? base.model,
    sampleRate: override.sampleRate ?? base.sampleRate,
    audioChunkDurationMS: override.audioChunkDurationMS ?? base.audioChunkDurationMS,
  };
}

/**
 * Cartesia speech to text.
 *
 * Supports:
 *  - Streaming
 *  - Turn detection
 *  - Interim results
 *
 * See https://docs.cartesia.ai/build-with-cartesia/stt-models/latest
 *
 * @example
 * ```typescript
 * import { voice } from '@livekit/agents';
 * import { STT, TTS } from '@livekit/agents-plugin-cartesia';
 *
 * const session = new voice.AgentSession({
 *   stt: new STT(),
 *   llm: new LLM(), // choose your favorite LLM
 *   tts: new TTS(),
 *   turnHandling: { turnDetection: 'stt' },
 * });
 * ```
 */
export class STT extends stt.STT {
  #opts: STTOptions;

  constructor(opts: Partial<STTOptions> = {}) {
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: false,
      diarization: false,
    });

    const apiKey = opts.apiKey ?? process.env.CARTESIA_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Cartesia API key is required, whether as an argument or as $CARTESIA_API_KEY',
      );
    }

    this.#opts = mergeSTTOptions({ ...defaultSTTOptions, apiKey }, opts);
  }

  override get label(): string {
    return 'cartesia.STT';
  }

  override get model(): string {
    return this.#opts.model;
  }

  override get provider(): string {
    return 'Cartesia';
  }

  protected override async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('Cartesia STT does not support batch recognition, use stream() instead');
  }

  override stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #logger = log();
  #ws: WebSocket | null = null;
  #requestId: string | undefined;
  #speaking = false;
  #currentTranscript = '';
  #speechDuration = 0;
  #closingWs = false;

  constructor(sttInstance: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(sttInstance, opts.sampleRate, connOptions);
    this.#opts = { ...opts };
  }

  override get label(): string {
    return 'cartesia.SpeechStream';
  }

  protected override async run() {
    if (this.closed) {
      this.close();
      return;
    }

    this.#speaking = false;
    this.#currentTranscript = '';
    this.#speechDuration = 0;
    this.#closingWs = false;

    let keepaliveInterval: NodeJS.Timeout | undefined;
    const abortController = new AbortController();

    try {
      const url = this.#getCartesiaUrl();
      this.#logger.debug(`Connecting to Cartesia STT: ${url}`);

      const ws = new WebSocket(url, {
        headers: {
          [AUTHORIZATION_HEADER]: this.#opts.apiKey,
          [VERSION_HEADER]: API_VERSION,
        },
      });
      this.#ws = ws;

      // Cartesia returns the request id on the WS upgrade response, before any
      // turn events are sent. Capture it so logs and metrics emitted on the
      // connection (and any pre-`turn.start` errors) are attributable.
      ws.once('upgrade', (response: IncomingMessage) => {
        const headerValue = response.headers[REQUEST_ID_HEADER];
        const requestId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
        if (requestId) {
          this.#requestId = requestId;
          this.#logger.debug({ cartesiaRequestId: requestId }, 'Cartesia STT WebSocket connected');
        }
      });

      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          ws.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          ws.off('open', onOpen);
          reject(new APIConnectionError({ message: err.message, options: { retryable: true } }));
        };

        ws.once('open', onOpen);
        ws.once('error', onError);
      });

      // If one task fails, abort its peer and close the WS so the peer can
      // exit before we re-throw. Otherwise a dangling task would survive
      // into the next retry attempt (sendTask blocked on input.next() would
      // steal frames; recvTask's close handler could still push events to
      // the queue and surface an unhandled rejection).
      let firstError: unknown;
      const stopPeer = (err: unknown) => {
        if (firstError === undefined) firstError = err;
        abortController.abort();
        if (ws.readyState === WebSocket.OPEN) ws.close();
      };
      const sendPromise = this.#sendTask(ws, abortController.signal).catch(stopPeer);
      const recvPromise = this.#recvTask(ws).catch(stopPeer);

      keepaliveInterval = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        } catch {
          // ignore
        }
      }, KEEPALIVE_INTERVAL_MS);
      await Promise.all([sendPromise, recvPromise]);
      if (firstError !== undefined) throw firstError;
    } catch (error) {
      this.#logger.error('Cartesia STT stream error', { error });
      throw error;
    } finally {
      abortController.abort();
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.close();
      }
    }

    this.close();
  }

  async #sendTask(ws: WebSocket, abortSignal: AbortSignal) {
    const samplesPerChunk = Math.floor(
      (this.#opts.sampleRate * this.#opts.audioChunkDurationMS) / 1000,
    );
    const audioBstream = new AudioByteStream(this.#opts.sampleRate, 1, samplesPerChunk);

    let hasEnded = false;
    const iterator = this.input[Symbol.asyncIterator]();
    const abortPromise = waitForAbort(abortSignal);

    while (true) {
      const result = await Promise.race([iterator.next(), abortPromise]);

      if (result === undefined) return; // aborted

      if (result.done) {
        hasEnded = true;
      } else {
        const data = result.value;
        const frames: AudioFrame[] = [];

        if (data === SpeechStream.FLUSH_SENTINEL) {
          frames.push(...audioBstream.flush());
        } else {
          // Pass the typed array directly so AudioByteStream uses byteOffset/
          // byteLength — `.buffer` would include foreign bytes when rtc-node
          // hands us a view over a pooled allocator.
          frames.push(...audioBstream.write(data.data));
        }

        for (const frame of frames) {
          this.#speechDuration += calculateAudioDurationSeconds(frame);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(frame.data);
          }
        }
      }

      if (hasEnded) break;
    }

    if (ws.readyState === WebSocket.OPEN) {
      this.#closingWs = true;
      this.#logger.debug('Sending close message to Cartesia STT');
      ws.send(JSON.stringify({ type: 'close' }));

      // After `close`, the server should flush any pending turn events and
      // close the socket. If it hangs, force the issue rather than letting
      // the stream wait forever.
      const drainTimer = setTimeout(() => {
        this.#logger.warn(
          `Cartesia STT did not close within ${DRAIN_TIMEOUT_MS}ms after done; forcing close`,
        );
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
          ws.terminate();
        }
      }, DRAIN_TIMEOUT_MS);
      ws.once('close', () => clearTimeout(drainTimer));
    }
  }

  async #recvTask(ws: WebSocket) {
    let pendingError: Error | undefined = undefined;

    return new Promise<void>((resolve, reject) => {
      const settle = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.#logger.warn('Received unexpected binary message from Cartesia STT');
          return;
        }
        let msg: STTEventMessage;
        try {
          msg = JSON.parse(data.toString());
        } catch (error) {
          this.#logger.error('Failed to parse Cartesia STT message', { error });
          return;
        }
        try {
          if (msg.type === 'error') {
            this.#logger.error('Cartesia sent an error', msg);

            // do not close the websocket on bad requests since that may be caused by invalid messages
            if (msg.status_code === undefined || msg.status_code >= 500) {
              // Defer until the WS is fully closed so we don't race the `close`
              // handler with a rejected `recvTask`. Close the socket explicitly
              // in case the server doesn't, otherwise recv would hang.
              pendingError = new APIConnectionError({
                message: msg.message || msg.title,
                options: {
                  retryable: true,
                },
              });
              ws.close();
              return;
            }
          } else {
            this.#processStreamEvent(msg);
          }
        } catch (error) {
          this.#logger.error('Failed to process Cartesia STT message', { error });
        }
      });

      ws.on('close', (code, reason) => {
        // If a turn was in progress, close it out so consumers see a balanced
        // START_OF_SPEECH/END_OF_SPEECH pair and don't carry stale turn state
        // into the next reconnect.
        if (this.#speaking) {
          if (this.#currentTranscript) {
            this.#sendTranscriptEvent(
              stt.SpeechEventType.FINAL_TRANSCRIPT,
              this.#currentTranscript,
            );
          }
          if (!this.queue.closed)
            this.queue.put({
              type: stt.SpeechEventType.END_OF_SPEECH,
              requestId: this.#requestId,
            });
          this.#logger.debug('Cartesia STT END_OF_SPEECH');
          if (this.#speechDuration > 0 && !this.queue.closed) {
            this.queue.put({
              type: stt.SpeechEventType.RECOGNITION_USAGE,
              requestId: this.#requestId,
              recognitionUsage: { audioDuration: this.#speechDuration },
            });
            this.#speechDuration = 0;
          }
          this.#speaking = false;
          this.#currentTranscript = '';
        }

        if (pendingError) {
          settle(pendingError);
          return;
        }
        if (this.#closingWs || this.closed) {
          settle();
          return;
        }
        this.#logger.warn(`Cartesia STT WebSocket closed: ${code} ${reason.toString()}`);
        settle(
          new APIConnectionError({
            message: `Cartesia STT connection closed unexpectedly (code=${code})`,
            options: { retryable: true },
          }),
        );
      });

      ws.on('error', (err) => {
        if (this.closed) {
          settle();
          return;
        }
        settle(new APIConnectionError({ message: err.message, options: { retryable: true } }));
      });
    });
  }

  #processStreamEvent(data: Exclude<STTEventMessage, { type: 'error' }>) {
    if (data.request_id) {
      this.#requestId = data.request_id;
    }

    switch (data.type) {
      case 'connected':
        return;

      case 'turn.start': {
        if (this.#speaking) return;
        this.#speaking = true;
        this.#currentTranscript = '';
        if (!this.queue.closed)
          this.queue.put({
            type: stt.SpeechEventType.START_OF_SPEECH,
            requestId: this.#requestId,
          });
        this.#logger.debug('Cartesia STT START_OF_SPEECH');
        return;
      }

      case 'turn.update': {
        if (!this.#speaking) return;
        const transcript = data.transcript;
        if (!transcript) return;
        // Only emit interim updates when the cumulative transcript actually
        // changed; this avoids canceling preflight generation needlessly.
        if (this.#currentTranscript === transcript) return;
        this.#currentTranscript = transcript;
        this.#sendTranscriptEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, transcript);
        return;
      }

      case 'turn.eager_end': {
        if (!this.#speaking) return;
        const transcript = data.transcript;
        if (!transcript) return;
        this.#currentTranscript = transcript;
        this.#sendTranscriptEvent(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, transcript);
        return;
      }

      case 'turn.resume':
        // turn.resume has no transcript; re-emit the latest cumulative transcript
        // as an interim event so the pipeline cancels the pending preflight.
        if (!this.#speaking || !this.#currentTranscript) return;
        this.#sendTranscriptEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, this.#currentTranscript);
        return;

      case 'turn.end': {
        if (!this.#speaking) return;
        const transcript = data.transcript;

        this.#sendTranscriptEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, transcript);

        this.#speaking = false;
        if (!this.queue.closed)
          this.queue.put({
            type: stt.SpeechEventType.END_OF_SPEECH,
            requestId: this.#requestId,
          });
        this.#logger.debug('Cartesia STT END_OF_SPEECH');
        this.#currentTranscript = '';

        if (this.#speechDuration > 0 && !this.queue.closed) {
          this.queue.put({
            type: stt.SpeechEventType.RECOGNITION_USAGE,
            requestId: this.#requestId,
            recognitionUsage: { audioDuration: this.#speechDuration },
          });
          this.#speechDuration = 0;
        }

        return;
      }

      default:
        this.#logger.warn('received unexpected message from Cartesia STT', { data });
    }
  }

  #sendTranscriptEvent(eventType: stt.SpeechEventType, transcript: string) {
    if (this.queue.closed) return;
    this.queue.put({
      type: eventType,
      requestId: this.#requestId,
      alternatives: [
        {
          // Cartesia STT only supports English at this time.
          language: asLanguageCode('en'),
          text: transcript,
          startTime: 0,
          endTime: 0,
          confidence: 0,
        },
      ],
    });
  }

  #getCartesiaUrl(): string {
    const params = new URLSearchParams({
      model: this.#opts.model,
      sample_rate: this.#opts.sampleRate.toString(),
      encoding: AUDIO_ENCODING,
    });

    const wsBase = this.#opts.baseUrl.replace(/^http/, 'ws');
    return `${wsBase}/stt/turns/websocket?${params.toString()}`;
  }

  override close() {
    super.close();
    this.#ws?.close();
  }
}
