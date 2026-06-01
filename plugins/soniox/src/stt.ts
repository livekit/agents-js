// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  log,
  stt,
  waitForAbort,
} from '@livekit/agents';
import { WebSocket } from 'ws';
import { type SonioxMessage, newProcessMessageState, processMessage } from './_internal.js';

const BASE_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const KEEPALIVE_MESSAGE = '{"type":"keepalive"}';
// An empty frame tells Soniox to end the session: it flushes remaining tokens,
// emits a `finished` response, then closes the connection.
const END_OF_AUDIO_MESSAGE = Buffer.alloc(0);

/** @public */
export interface ContextGeneralItem {
  key: string;
  value: string;
}

/** @public */
export interface ContextTranslationTerm {
  source: string;
  target: string;
}

/** @public */
export interface ContextObject {
  /** Context key-value pairs. */
  general?: ContextGeneralItem[];
  /** Free-form text context. */
  text?: string;
  /** Terms to bias recognition toward. */
  terms?: string[];
  /** Translation-specific source/target term pairs. */
  translationTerms?: ContextTranslationTerm[];
}

/** @public */
export type TranslationConfig =
  | {
      type: 'one_way';
      /** Target language for one-way translation. */
      targetLanguage: string;
    }
  | {
      type: 'two_way';
      /** First language for two-way translation. */
      languageA: string;
      /** Second language for two-way translation. */
      languageB: string;
    };

/** @public */
export interface STTOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  languageHints?: string[];
  languageHintsStrict: boolean;
  context?: ContextObject | string;
  numChannels: number;
  sampleRate: number;
  enableSpeakerDiarization: boolean;
  enableLanguageIdentification: boolean;
  /** Maximum delay in milliseconds between speech cessation and endpoint detection. */
  maxEndpointDelayMs: number;
  clientReferenceId?: string;
  translation?: TranslationConfig;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.SONIOX_API_KEY,
  baseUrl: BASE_URL,
  model: 'stt-rt-v4',
  languageHintsStrict: false,
  numChannels: 1,
  sampleRate: 16000,
  enableSpeakerDiarization: false,
  enableLanguageIdentification: true,
  maxEndpointDelayMs: 500,
};

/** @public */
export class STT extends stt.STT {
  #opts: STTOptions;
  label = 'soniox.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    const merged = { ...defaultSTTOptions, ...opts };
    if (!merged.apiKey) {
      throw new Error('Soniox API key is required. Set SONIOX_API_KEY or pass apiKey');
    }
    if (merged.maxEndpointDelayMs < 500 || merged.maxEndpointDelayMs > 3000) {
      throw new Error('maxEndpointDelayMs must be between 500 and 3000');
    }

    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'chunk',
      diarization: merged.enableSpeakerDiarization,
    });
    this.#opts = merged;
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Soniox';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Soniox Speech-to-Text API does not support single frame recognition');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #logger = log();
  label = 'soniox.SpeechStream';

  constructor(stt: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    let ws: WebSocket | undefined;
    try {
      ws = await this.#connectWS();
      await this.#runWS(ws);
    } catch (error) {
      if (error instanceof APIError) {
        throw error;
      }
      throw new APIConnectionError({
        message: `Soniox Speech-to-Text API connection error: ${error}`,
      });
    } finally {
      ws?.close();
    }
  }

  async #connectWS(): Promise<WebSocket> {
    const ws = new WebSocket(this.#opts.baseUrl);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ws.terminate();
    }, 10000);

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (error) => reject(error));
        ws.once('close', (code) => reject(new Error(`WebSocket returned ${code}`)));
      });
    } catch (error) {
      // Only our own timeout above is a genuine timeout; every other failure
      // (connection refused, DNS, handshake error) is a connection error.
      if (timedOut) {
        throw new APITimeoutError({
          message: 'Timeout connecting to or initializing Soniox Speech-to-Text API session',
        });
      }
      throw new APIConnectionError({
        message: `Soniox Speech-to-Text API connection error: ${error}`,
      });
    } finally {
      clearTimeout(timeout);
    }

    ws.send(JSON.stringify(this.#config()));
    return ws;
  }

  #config(): Record<string, unknown> {
    const config: Record<string, unknown> = {
      api_key: this.#opts.apiKey,
      model: this.#opts.model,
      audio_format: 'pcm_s16le',
      num_channels: this.#opts.numChannels,
      enable_endpoint_detection: true,
      sample_rate: this.#opts.sampleRate,
      language_hints: this.#opts.languageHints,
      language_hints_strict: this.#opts.languageHintsStrict,
      context: serializeContext(this.#opts.context),
      enable_speaker_diarization: this.#opts.enableSpeakerDiarization,
      enable_language_identification: this.#opts.enableLanguageIdentification,
      client_reference_id: this.#opts.clientReferenceId,
      max_endpoint_delay_ms: this.#opts.maxEndpointDelayMs,
    };

    if (this.#opts.translation) {
      config.translation = serializeTranslation(this.#opts.translation);
    }

    return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
  }

  async #runWS(ws: WebSocket): Promise<void> {
    let closing = false;
    const state = newProcessMessageState();
    const options = {
      isTranslationMode: this.#opts.translation !== undefined,
      startTimeOffset: this.startTimeOffset,
    };

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(KEEPALIVE_MESSAGE);
      }
    }, 5000);

    const listenTask = new Promise<void>((resolve, reject) => {
      ws.on('message', (msg) => {
        try {
          const content = JSON.parse(msg.toString()) as SonioxMessage;
          for (const event of processMessage(state, content, options)) {
            this.#put(event);
          }
          if (content.error_code || content.error_message) {
            const statusCode = parseStatusCode(content.error_code);
            const errorMessage = content.error_message ?? 'Unknown Soniox STT error';
            this.#logger.error(`WebSocket error: ${content.error_code ?? ''} - ${errorMessage}`);
            reject(
              new APIStatusError({
                message: `Soniox STT error: ${content.error_code ?? ''} - ${errorMessage}`,
                options: { statusCode, body: content },
              }),
            );
            return;
          }
          if (content.finished) {
            resolve();
          }
        } catch (error) {
          reject(error);
        }
      });
      ws.once('error', (error) => reject(error));
      ws.once('close', (code) => {
        if (!closing) {
          reject(new Error(`Soniox STT WebSocket closed with code ${code}`));
        } else {
          resolve();
        }
      });
    });

    // Drain the audio input; when it ends gracefully, signal end-of-audio so
    // the server flushes its remaining tokens, emits `finished`, and closes the
    // connection (per Soniox protocol: an empty frame ends the session). We then
    // let `listenTask` observe that final response rather than tearing down the
    // moment the input runs dry.
    const sendTask = this.#sendAudio(ws);
    const finalize = sendTask.then(() => {
      if (this.abortSignal.aborted || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      closing = true;
      ws.send(END_OF_AUDIO_MESSAGE);
    });

    try {
      // `finalize` is raced only so a send-side failure propagates — its normal
      // completion never wins (input drained → keep listening). Teardown is
      // driven by the server's `finished`/close (listenTask) or by abort.
      await Promise.race([
        listenTask,
        waitForAbort(this.abortSignal),
        finalize.then(() => new Promise<void>(() => {})),
      ]);
    } finally {
      closing = true;
      clearInterval(keepalive);
      ws.close();
    }
  }

  async #sendAudio(ws: WebSocket): Promise<void> {
    const abortPromise = waitForAbort(this.abortSignal);
    while (!this.closed) {
      const result = await Promise.race([this.input.next(), abortPromise]);
      if (result === undefined || result.done) {
        break;
      }

      const data = result.value;
      if (data === SpeechStream.FLUSH_SENTINEL) {
        continue;
      }
      // Send only this frame's bytes. `data.data` may be a view into a larger
      // ArrayBuffer (non-zero byteOffset / partial span), so `.buffer` alone
      // would transmit the wrong bytes; honor byteOffset/byteLength (mirrors
      // Python's `frame.data.tobytes()`).
      ws.send(Buffer.from(data.data.buffer, data.data.byteOffset, data.data.byteLength));
    }
  }

  #put(event: stt.SpeechEvent): void {
    if (!this.queue.closed) {
      this.queue.put(event);
    }
  }
}

const serializeContext = (context: ContextObject | string | undefined): unknown => {
  if (context === undefined || typeof context === 'string') return context;
  return {
    general: context.general,
    text: context.text,
    terms: context.terms,
    translation_terms: context.translationTerms,
  };
};

const serializeTranslation = (translation: TranslationConfig): Record<string, string> => {
  if (translation.type === 'one_way') {
    return { type: 'one_way', target_language: translation.targetLanguage };
  }
  return {
    type: 'two_way',
    language_a: translation.languageA,
    language_b: translation.languageB,
  };
};

const parseStatusCode = (errorCode: string | number | undefined): number => {
  if (typeof errorCode === 'number') return Number.isInteger(errorCode) ? errorCode : -1;
  if (typeof errorCode === 'string' && /^\d+$/.test(errorCode)) return Number(errorCode);
  return -1;
};
