// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APITimeoutError,
  type AudioBuffer,
  log,
  stt,
  waitForAbort,
} from '@livekit/agents';
import { WebSocket } from 'ws';

const BASE_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const KEEPALIVE_MESSAGE = '{"type":"keepalive"}';
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

interface SonioxToken {
  text: string;
  is_final: boolean;
  translation_status?: string;
  language?: string;
  speaker?: string | number;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
}

interface SonioxMessage {
  tokens?: SonioxToken[];
  total_audio_proc_ms?: number;
  finished?: boolean;
  error_code?: string;
  error_message?: string;
}

/** @public */
export class SpeechStream extends stt.SpeechStream {
  #opts: STTOptions;
  #logger = log();
  #reportedDurationMs = 0;
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
      if (error instanceof APITimeoutError || error instanceof APIConnectionError) {
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
    const timeout = setTimeout(() => {
      ws.terminate();
    }, 10000);

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (error) => reject(error));
        ws.once('close', (code) => reject(new Error(`WebSocket returned ${code}`)));
      });
    } catch (error) {
      throw new APITimeoutError({
        message: `Timeout connecting to or initializing Soniox Speech-to-Text API session: ${error}`,
      });
    } finally {
      clearTimeout(timeout);
    }

    ws.send(JSON.stringify(this.#config()));
    this.#reportedDurationMs = 0;
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
    const isTranslationMode = this.#opts.translation !== undefined;
    const final = new TokenAccumulator();
    const finalOriginal = new TokenAccumulator();
    let isSpeaking = false;

    const sendEndpointTranscript = () => {
      if (final.text) {
        const [srcSegs, tgtSegs] = isTranslationMode
          ? [finalOriginal.langSegments, final.langSegments]
          : [final.langSegments, []];
        const [sourceLanguages, sourceTexts] = langSegmentsToFields(srcSegs);
        const [targetLanguages, targetTexts] = langSegmentsToFields(tgtSegs);

        this.#put({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          alternatives: [
            final.toSpeechData(this.startTimeOffset, {
              sourceLanguages,
              sourceTexts,
              targetLanguages,
              targetTexts,
            }),
          ],
        });
        this.#put({ type: stt.SpeechEventType.END_OF_SPEECH });
        final.reset();
        finalOriginal.reset();
        isSpeaking = false;
      } else {
        finalOriginal.reset();
      }
    };

    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(KEEPALIVE_MESSAGE);
      }
    }, 5000);

    const sendTask = this.#sendAudio(ws, () => {
      closing = true;
    });

    const listenTask = new Promise<void>((resolve, reject) => {
      ws.on('message', (msg) => {
        try {
          const content = JSON.parse(msg.toString()) as SonioxMessage;
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
              this.#put({ type: stt.SpeechEventType.START_OF_SPEECH });
            }

            const mergedOriginals = mergeLangSegments(
              finalOriginal.langSegments,
              nonFinalOriginal.langSegments,
            );
            const mergedPrimary = mergeLangSegments(final.langSegments, nonFinal.langSegments);
            const [srcSegs, tgtSegs] = isTranslationMode
              ? [mergedOriginals, mergedPrimary]
              : [mergedPrimary, []];
            const [sourceLanguages, sourceTexts] = langSegmentsToFields(srcSegs);
            const [targetLanguages, targetTexts] = langSegmentsToFields(tgtSegs);
            const eventType =
              final.text && !nonFinal.text
                ? stt.SpeechEventType.PREFLIGHT_TRANSCRIPT
                : stt.SpeechEventType.INTERIM_TRANSCRIPT;

            this.#put({
              type: eventType,
              alternatives: [
                final.mergedSpeechData(nonFinal, this.startTimeOffset, {
                  sourceLanguages,
                  sourceTexts,
                  targetLanguages,
                  targetTexts,
                }),
              ],
            });
          }

          if (content.finished || content.error_code || content.error_message) {
            sendEndpointTranscript();
            this.#reportProcessedAudioDuration(totalAudioProcMs);
          }

          if (content.error_code || content.error_message) {
            this.#logger.error(
              `WebSocket error: ${content.error_code ?? ''} - ${content.error_message ?? ''}`,
            );
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

    try {
      await Promise.race([sendTask, listenTask, waitForAbort(this.abortSignal)]);
    } finally {
      closing = true;
      clearInterval(keepalive);
      ws.close();
    }
  }

  async #sendAudio(ws: WebSocket, onClosing: () => void): Promise<void> {
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
      ws.send(data.data.buffer);
    }
    onClosing();
  }

  #reportProcessedAudioDuration(totalAudioProcMs: number): void {
    const toReportMs = totalAudioProcMs - this.#reportedDurationMs;
    if (toReportMs <= 0) return;
    this.#put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      recognitionUsage: {
        audioDuration: toReportMs / 1000,
      },
    });
    this.#reportedDurationMs = Math.trunc(totalAudioProcMs);
  }

  #put(event: stt.SpeechEvent): void {
    if (!this.queue.closed) {
      this.queue.put(event);
    }
  }
}

const isEndToken = (token: SonioxToken): boolean =>
  token.text === END_TOKEN || token.text === FINALIZED_TOKEN;

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

type LangSegment = [stt.SpeechData['language'], string];

const mergeLangSegments = (a: LangSegment[], b: LangSegment[]): LangSegment[] => {
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

const langSegmentsToFields = (
  segments: LangSegment[],
): [stt.SpeechData['sourceLanguages'] | undefined, string[] | undefined] => {
  if (segments.length === 0) return [undefined, undefined];
  return [segments.map(([lang]) => lang), segments.map(([, text]) => text)];
};

interface SpeechDataFields {
  sourceLanguages?: stt.SpeechData['sourceLanguages'];
  sourceTexts?: string[];
  targetLanguages?: stt.SpeechData['targetLanguages'];
  targetTexts?: string[];
}

interface LangStats {
  numChars: number;
  updatedAt: number;
}

class TokenAccumulator {
  text = '';
  language: stt.SpeechData['language'] = '' as stt.SpeechData['language'];
  speakerId?: string;
  startTime = 0;
  endTime = 0;
  #confidenceSum = 0;
  #confidenceCount = 0;
  #hasStartTime = false;
  #langSegments: LangSegment[] = [];
  #langStats = new Map<string, LangStats>();

  get langSegments(): LangSegment[] {
    return this.#langSegments;
  }

  get confidence(): number {
    return this.#confidenceCount === 0 ? 0 : this.#confidenceSum / this.#confidenceCount;
  }

  update(token: SonioxToken): void {
    const text = token.text;
    const lang = (token.language ?? '') as stt.SpeechData['language'];
    this.text += text;
    if (lang && text) {
      const stats = this.#langStats.get(lang) ?? { numChars: 0, updatedAt: 0 };
      this.#langStats.set(lang, { numChars: stats.numChars + text.length, updatedAt: Date.now() });
      this.language = this.#getLanguage();
    }
    if (token.speaker !== undefined && this.speakerId === undefined) {
      this.speakerId = String(token.speaker);
    }
    if (token.start_ms !== undefined && !this.#hasStartTime) {
      this.#hasStartTime = true;
      this.startTime = token.start_ms;
    }
    if (token.end_ms !== undefined) {
      this.endTime = token.end_ms;
    }
    if (token.confidence !== undefined) {
      this.#confidenceSum += token.confidence;
      this.#confidenceCount += 1;
    }
    if (text) {
      const last = this.#langSegments[this.#langSegments.length - 1];
      if (last && last[0] === lang) {
        last[1] += text;
      } else {
        this.#langSegments.push([lang, text]);
      }
    }
  }

  reset(): void {
    this.text = '';
    this.language = '' as stt.SpeechData['language'];
    this.speakerId = undefined;
    this.startTime = 0;
    this.endTime = 0;
    this.#confidenceSum = 0;
    this.#confidenceCount = 0;
    this.#hasStartTime = false;
    this.#langSegments = [];
    this.#langStats.clear();
  }

  toSpeechData(startTimeOffset = 0, fields: SpeechDataFields = {}): stt.SpeechData {
    return {
      text: this.text,
      language: this.language,
      sourceLanguages: fields.sourceLanguages,
      sourceTexts: fields.sourceTexts,
      targetLanguages: fields.targetLanguages,
      targetTexts: fields.targetTexts,
      speakerId: this.speakerId,
      startTime: this.startTime / 1000 + startTimeOffset,
      endTime: this.endTime / 1000 + startTimeOffset,
      confidence: this.confidence,
    };
  }

  mergedSpeechData(
    other: TokenAccumulator,
    startTimeOffset = 0,
    fields: SpeechDataFields = {},
  ): stt.SpeechData {
    const starts = [this, other].filter((acc) => acc.#hasStartTime).map((acc) => acc.startTime);
    const start = starts.length ? Math.min(...starts) : 0;
    const totalCount = this.#confidenceCount + other.#confidenceCount;
    const totalSum = this.#confidenceSum + other.#confidenceSum;
    return {
      text: this.text + other.text,
      language: this.language || other.language,
      sourceLanguages: fields.sourceLanguages,
      sourceTexts: fields.sourceTexts,
      targetLanguages: fields.targetLanguages,
      targetTexts: fields.targetTexts,
      speakerId: this.speakerId ?? other.speakerId,
      startTime: start / 1000 + startTimeOffset,
      endTime: Math.max(this.endTime, other.endTime) / 1000 + startTimeOffset,
      confidence: totalCount > 0 ? totalSum / totalCount : 0,
    };
  }

  #getLanguage(): stt.SpeechData['language'] {
    let selected = '';
    let selectedStats: LangStats | undefined;
    for (const [lang, stats] of this.#langStats) {
      if (
        !selectedStats ||
        stats.numChars > selectedStats.numChars ||
        (stats.numChars === selectedStats.numChars && stats.updatedAt < selectedStats.updatedAt)
      ) {
        selected = lang;
        selectedStats = stats;
      }
    }
    return selected as stt.SpeechData['language'];
  }
}
