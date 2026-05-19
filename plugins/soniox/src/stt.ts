// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  DEFAULT_API_CONNECT_OPTIONS,
  asLanguageCode,
  log,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import type { STTModels } from './models.js';

const BASE_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const KEEPALIVE_MESSAGE = JSON.stringify({ type: 'keepalive' });
const END_TOKEN = '<end>';
const FINALIZED_TOKEN = '<fin>';

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
  /** Context entries for models with context_version 2. */
  general?: ContextGeneralItem[] | null;
  text?: string | null;
  terms?: string[] | null;
  translationTerms?: ContextTranslationTerm[] | null;
}

/** @public */
export interface TranslationConfig {
  type: 'one_way' | 'two_way';
  targetLanguage?: string | null;
  languageA?: string | null;
  languageB?: string | null;
}

/** @public */
export interface STTOptions {
  apiKey?: string;
  baseUrl: string;
  model: STTModels;
  languageHints?: string[] | null;
  languageHintsStrict: boolean;
  context?: ContextObject | string | null;
  numChannels: number;
  sampleRate: number;
  enableSpeakerDiarization: boolean;
  enableLanguageIdentification: boolean;
  maxEndpointDelayMs: number;
  clientReferenceId?: string | null;
  translation?: TranslationConfig | null;
}

const defaultSTTOptions: STTOptions = {
  apiKey: process.env.SONIOX_API_KEY,
  baseUrl: BASE_URL,
  model: 'stt-rt-v4',
  languageHints: null,
  languageHintsStrict: false,
  context: null,
  numChannels: 1,
  sampleRate: 16000,
  enableSpeakerDiarization: false,
  enableLanguageIdentification: true,
  maxEndpointDelayMs: 500,
  clientReferenceId: null,
  translation: null,
};

const isEndToken = (token: SonioxToken): boolean => {
  return token.text === END_TOKEN || token.text === FINALIZED_TOKEN;
};

const toSnakeContext = (context: ContextObject | string | null | undefined) => {
  if (context == null || typeof context === 'string') return context;
  return {
    general: context.general,
    text: context.text,
    terms: context.terms,
    translation_terms: context.translationTerms,
  };
};

/** @public */
export class STT extends stt.STT {
  #opts: STTOptions;
  label = 'soniox.STT';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Soniox';
  }

  constructor(opts: Partial<STTOptions> = {}) {
    const resolved = { ...defaultSTTOptions, ...opts };
    if (!resolved.apiKey) {
      throw new Error('Soniox API key is required, whether as an argument or as $SONIOX_API_KEY');
    }
    if (resolved.maxEndpointDelayMs < 500 || resolved.maxEndpointDelayMs > 3000) {
      throw new Error('maxEndpointDelayMs must be between 500 and 3000');
    }
    if (resolved.translation?.type === 'one_way' && !resolved.translation.targetLanguage) {
      throw new Error('targetLanguage is required for one_way translation');
    }
    if (
      resolved.translation?.type === 'two_way' &&
      (!resolved.translation.languageA || !resolved.translation.languageB)
    ) {
      throw new Error('languageA and languageB are both required for two_way translation');
    }

    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'chunk',
      diarization: resolved.enableSpeakerDiarization,
    });
    this.#opts = resolved;
  }

  updateOptions(opts: Partial<STTOptions>) {
    this.#opts = { ...this.#opts, ...opts };
    this.updateCapabilities({ diarization: this.#opts.enableSpeakerDiarization });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _recognize(_buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new Error('Soniox STT does not support single-frame recognition');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new SpeechStream(this, this.#opts, options?.connOptions);
  }
}

interface SonioxToken {
  text: string;
  is_final: boolean;
  language?: string;
  speaker?: string | number;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  translation_status?: string;
}

interface SonioxMessage {
  tokens?: SonioxToken[];
  total_audio_proc_ms?: number;
  finished?: boolean;
  error_code?: number | string;
  error_message?: string;
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #ws: WebSocket | null = null;
  #logger = log();
  #connOptions: APIConnectOptions;
  #reportedDurationMs = 0;
  label = 'soniox.SpeechStream';

  constructor(stt: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
    super(stt, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#connOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
  }

  protected async run(): Promise<void> {
    while (!this.closed && !this.input.closed && !this.abortSignal.aborted) {
      const ws = await this.#connect();
      this.#ws = ws;
      const reconnect = new AbortController();
      let shouldReconnect = false;

      try {
        await Promise.race([
          this.#sendAudioLoop(ws, reconnect.signal),
          this.#recvMessagesLoop(ws).then((reconnectRequested) => {
            shouldReconnect = reconnectRequested;
          }),
          this.#keepaliveLoop(ws, reconnect.signal),
          waitForAbort(this.abortSignal),
        ]);
      } finally {
        reconnect.abort();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
        this.#ws = null;
      }

      if (!shouldReconnect || this.closed || this.input.closed || this.abortSignal.aborted) {
        break;
      }
    }
  }

  async #connect(): Promise<WebSocket> {
    const config: Record<string, unknown> = {
      api_key: this.#opts.apiKey,
      model: this.#opts.model,
      audio_format: 'pcm_s16le',
      num_channels: this.#opts.numChannels,
      enable_endpoint_detection: true,
      sample_rate: this.#opts.sampleRate,
      language_hints: this.#opts.languageHints,
      language_hints_strict: this.#opts.languageHintsStrict,
      context: toSnakeContext(this.#opts.context),
      enable_speaker_diarization: this.#opts.enableSpeakerDiarization,
      enable_language_identification: this.#opts.enableLanguageIdentification,
      client_reference_id: this.#opts.clientReferenceId,
      max_endpoint_delay_ms: this.#opts.maxEndpointDelayMs,
    };

    if (this.#opts.translation) {
      const translation = this.#opts.translation;
      config.translation = {
        type: translation.type,
        target_language: translation.targetLanguage,
        language_a: translation.languageA,
        language_b: translation.languageB,
      };
    }

    const ws = new WebSocket(this.#opts.baseUrl);
    await waitForWsOpen(ws, this.#connOptions.timeoutMs, this.abortSignal);
    ws.send(JSON.stringify(config));
    this.#reportedDurationMs = 0;
    this.#logger.debug('Soniox STT WebSocket connection established');
    return ws;
  }

  async #sendAudioLoop(ws: WebSocket, signal: AbortSignal): Promise<void> {
    while (
      !this.closed &&
      !this.input.closed &&
      !signal.aborted &&
      ws.readyState === WebSocket.OPEN
    ) {
      const result = await Promise.race([this.input.next(), waitForAbort(signal)]);
      if (result === undefined) return;
      if (result.done) return;
      if (result.value === SpeechStream.FLUSH_SENTINEL) continue;

      const frame = result.value as AudioFrame;
      ws.send(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
    }
  }

  async #keepaliveLoop(ws: WebSocket, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && ws.readyState === WebSocket.OPEN) {
      await Promise.race([delay(5000), waitForAbort(signal)]);
      if (!signal.aborted && ws.readyState === WebSocket.OPEN) {
        ws.send(KEEPALIVE_MESSAGE);
      }
    }
  }

  async #recvMessagesLoop(ws: WebSocket): Promise<boolean> {
    const final = new TokenAccumulator();
    const finalOriginal = new TokenAccumulator();
    let isSpeaking = false;
    const isTranslationMode = this.#opts.translation != null;

    const sendEndpointTranscript = () => {
      if (final.text) {
        const sourceLanguages = finalOriginal.langSegments.map(([lang]) => asLanguageCode(lang));
        const sourceTexts = finalOriginal.langSegments.map(([, text]) => text);
        this.queue.put({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          alternatives: [final.toSpeechData(this.startTimeOffset, sourceLanguages, sourceTexts)],
        });
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
        final.reset();
        finalOriginal.reset();
        isSpeaking = false;
      } else {
        finalOriginal.reset();
      }
    };

    try {
      for await (const raw of websocketMessages(ws, this.abortSignal)) {
        if (typeof raw !== 'string') {
          this.#logger.warn({ type: typeof raw }, 'unexpected message from Soniox STT');
          continue;
        }

        try {
          const content = JSON.parse(raw) as SonioxMessage;
          const tokens = content.tokens ?? [];
          const nonFinal = new TokenAccumulator();
          const nonFinalOriginal = new TokenAccumulator();
          const totalAudioProcMs = content.total_audio_proc_ms ?? 0;

          for (const token of tokens) {
            const isTranslated = token.translation_status === 'translation';
            if (isTranslationMode && !isEndToken(token) && !isTranslated) {
              if (token.is_final) {
                finalOriginal.update(token);
              } else {
                nonFinalOriginal.update(token);
              }
              continue;
            }

            if (token.is_final) {
              if (isEndToken(token)) {
                sendEndpointTranscript();
                this.#reportProcessedAudioDuration(totalAudioProcMs);
              } else {
                final.update(token);
              }
            } else {
              nonFinal.update(token);
            }
          }

          if (final.text || nonFinal.text) {
            if (!isSpeaking) {
              isSpeaking = true;
              this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
            }
            const interimSegments = mergeLangSegments(
              finalOriginal.langSegments,
              nonFinalOriginal.langSegments,
            );
            const eventType =
              final.text && !nonFinal.text
                ? stt.SpeechEventType.PREFLIGHT_TRANSCRIPT
                : stt.SpeechEventType.INTERIM_TRANSCRIPT;
            this.queue.put({
              type: eventType,
              alternatives: [
                final.mergedSpeechData(
                  nonFinal,
                  this.startTimeOffset,
                  interimSegments.map(([lang]) => asLanguageCode(lang)),
                  interimSegments.map(([, text]) => text),
                ),
              ],
            });
          }

          if (content.finished || content.error_code || content.error_message) {
            sendEndpointTranscript();
            this.#reportProcessedAudioDuration(totalAudioProcMs);
          }
          if (content.error_code || content.error_message) {
            this.#logger.error(
              `Soniox STT WebSocket error: ${content.error_code} - ${content.error_message}`,
            );
          }
        } catch (error) {
          this.#logger.error({ error }, 'error processing Soniox STT message');
        }
      }
    } catch (error) {
      if (this.abortSignal.aborted || this.closed) return false;
      this.#logger.error({ error }, 'Soniox STT WebSocket receive error');
    }

    if (!this.abortSignal.aborted && !this.closed && !this.input.closed) {
      this.#logger.warn('Soniox STT WebSocket closed; requesting reconnect');
      return true;
    }
    return false;
  }

  #reportProcessedAudioDuration(totalAudioProcMs: number) {
    const toReportMs = totalAudioProcMs - this.#reportedDurationMs;
    if (toReportMs <= 0) return;
    this.queue.put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      recognitionUsage: { audioDuration: toReportMs / 1000 },
    });
    this.#reportedDurationMs = Math.trunc(totalAudioProcMs);
  }
}

class TokenAccumulator {
  text = '';
  language = '';
  speakerId: string | null = null;
  startTime = 0;
  endTime = 0;
  confidenceSum = 0;
  confidenceCount = 0;
  hasStartTime = false;
  langSegments: [string, string][] = [];
  langStats = new Map<string, { numChars: number; updatedAt: number }>();

  update(token: SonioxToken) {
    const text = token.text;
    const lang = token.language ?? '';
    this.text += text;
    if (lang && text) {
      const stats = this.langStats.get(lang) ?? { numChars: 0, updatedAt: 0 };
      this.langStats.set(lang, {
        numChars: stats.numChars + text.length,
        updatedAt: performance.now(),
      });
      this.language = this.getLanguage();
    }
    if (token.speaker !== undefined && this.speakerId === null) {
      this.speakerId = String(token.speaker);
    }
    if (token.start_ms !== undefined && !this.hasStartTime) {
      this.hasStartTime = true;
      this.startTime = token.start_ms;
    }
    if (token.end_ms !== undefined) this.endTime = token.end_ms;
    if (token.confidence !== undefined) {
      this.confidenceSum += token.confidence;
      this.confidenceCount += 1;
    }
    if (text) {
      const last = this.langSegments[this.langSegments.length - 1];
      if (last && last[0] === lang) {
        last[1] += text;
      } else {
        this.langSegments.push([lang, text]);
      }
    }
  }

  get confidence(): number {
    return this.confidenceCount === 0 ? 0 : this.confidenceSum / this.confidenceCount;
  }

  getLanguage(): string {
    let bestLang = '';
    let bestChars = -1;
    let bestUpdatedAt = Number.POSITIVE_INFINITY;
    for (const [lang, stats] of this.langStats) {
      if (
        stats.numChars > bestChars ||
        (stats.numChars === bestChars && stats.updatedAt < bestUpdatedAt)
      ) {
        bestLang = lang;
        bestChars = stats.numChars;
        bestUpdatedAt = stats.updatedAt;
      }
    }
    return bestLang;
  }

  reset() {
    this.text = '';
    this.language = '';
    this.speakerId = null;
    this.startTime = 0;
    this.endTime = 0;
    this.confidenceSum = 0;
    this.confidenceCount = 0;
    this.hasStartTime = false;
    this.langSegments = [];
    this.langStats.clear();
  }

  toSpeechData(
    startTimeOffset = 0,
    sourceLanguages?: stt.SpeechData['sourceLanguages'],
    sourceTexts?: string[],
  ): stt.SpeechData {
    const metadata = sourceTexts?.length ? { sourceTexts } : undefined;
    return {
      text: this.text,
      language: asLanguageCode(this.language),
      sourceLanguages: sourceLanguages?.length ? sourceLanguages : undefined,
      metadata,
      speakerId: this.speakerId,
      startTime: this.startTime / 1000 + startTimeOffset,
      endTime: this.endTime / 1000 + startTimeOffset,
      confidence: this.confidence,
    };
  }

  mergedSpeechData(
    other: TokenAccumulator,
    startTimeOffset = 0,
    sourceLanguages?: stt.SpeechData['sourceLanguages'],
    sourceTexts?: string[],
  ): stt.SpeechData {
    const starts = [this, other].filter((acc) => acc.hasStartTime).map((acc) => acc.startTime);
    const totalCount = this.confidenceCount + other.confidenceCount;
    const metadata = sourceTexts?.length ? { sourceTexts } : undefined;
    return {
      text: this.text + other.text,
      language: asLanguageCode(this.language || other.language),
      sourceLanguages: sourceLanguages?.length ? sourceLanguages : undefined,
      metadata,
      speakerId: this.speakerId ?? other.speakerId,
      startTime: (starts.length ? Math.min(...starts) : 0) / 1000 + startTimeOffset,
      endTime: Math.max(this.endTime, other.endTime) / 1000 + startTimeOffset,
      confidence: totalCount > 0 ? (this.confidenceSum + other.confidenceSum) / totalCount : 0,
    };
  }
}

const mergeLangSegments = (a: [string, string][], b: [string, string][]): [string, string][] => {
  const result = [...a];
  for (const [lang, text] of b) {
    const last = result[result.length - 1];
    if (last && last[0] === lang) {
      last[1] += text;
    } else {
      result.push([lang, text]);
    }
  }
  return result;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForWsOpen = async (ws: WebSocket, timeoutMs: number, abortSignal: AbortSignal) => {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new APITimeoutError({})), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onClose);
      abortSignal.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new APIConnectionError({ message: `Soniox STT WebSocket error: ${error.message}` }));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(
        new APIStatusError({
          message: 'Soniox STT WebSocket closed during connect',
          options: { statusCode: code, body: { reason: reason.toString() } },
        }),
      );
    };
    const onAbort = () => {
      cleanup();
      reject(new APIConnectionError({ message: 'Soniox STT connection aborted' }));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('close', onClose);
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
};

async function* websocketMessages(
  ws: WebSocket,
  abortSignal: AbortSignal,
): AsyncGenerator<string | Buffer> {
  const messages: (string | Buffer)[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let error: Error | null = null;

  const onMessage = (data: WebSocket.RawData) => {
    messages.push(typeof data === 'string' ? data : Buffer.from(data as Buffer));
    notify?.();
  };
  const onClose = () => {
    done = true;
    notify?.();
  };
  const onError = (err: Error) => {
    error = err;
    done = true;
    notify?.();
  };
  const onAbort = () => {
    done = true;
    notify?.();
  };

  ws.on('message', onMessage);
  ws.on('close', onClose);
  ws.on('error', onError);
  abortSignal.addEventListener('abort', onAbort, { once: true });

  try {
    while (!done || messages.length > 0) {
      if (messages.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
      while (messages.length > 0) {
        yield messages.shift()!;
      }
    }
    if (error) throw error;
  } finally {
    ws.off('message', onMessage);
    ws.off('close', onClose);
    ws.off('error', onError);
    abortSignal.removeEventListener('abort', onAbort);
  }
}
