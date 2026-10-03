// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  type TimedString,
  asError,
  createTimedString,
  getBaseLanguage,
  log,
  normalizeLanguage,
  shortuuid,
  stream,
  tokenize,
  tts,
} from '@livekit/agents';
import { Mutex } from '@livekit/mutex';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { type TTSEncoding, type TTSModels, isDialogueModel } from './models.js';

const DEFAULT_VOICE_ID = 'bIHbv24MWmeRgasZH58o';
const API_BASE_URL_V1 = 'https://api.elevenlabs.io/v1';
const AUTHORIZATION_HEADER = 'xi-api-key';
const WS_INACTIVITY_TIMEOUT = 180;
const DEFAULT_ENCODING: TTSEncoding = 'pcm_22050';
const DIALOGUE_KEEP_ALIVE_INTERVAL = 10_000;
const DIALOGUE_VOICE_SETTINGS_FIELDS = new Set<keyof VoiceSettings>(['stability']);

export interface VoiceSettings {
  stability: number; // [0.0 - 1.0]
  similarity_boost: number; // [0.0 - 1.0]
  style?: number; // [0.0 - 1.0]
  speed?: number; // [0.8 - 1.2]
  use_speaker_boost?: boolean;
}

export interface Voice {
  id: string;
  name: string;
  category: string;
  settings?: VoiceSettings;
}

export interface PronunciationDictionaryLocator {
  pronunciation_dictionary_id: string;
  version_id: string;
}

export interface TTSOptions {
  apiKey?: string;
  // New interface
  voiceId?: string;
  voiceSettings?: VoiceSettings;
  model?: TTSModels | string;
  /**
   * Language code used to enforce a language for the model and text normalization. If the
   * model does not support language overrides, it will be ignored.
   */
  language?: string;
  // Legacy interface (backward compatibility)
  voice?: Voice;
  modelID?: TTSModels | string;
  languageCode?: string;
  // Common options
  baseURL?: string;
  encoding?: TTSEncoding;
  streamingLatency?: number;
  wordTokenizer?: tokenize.WordTokenizer | tokenize.SentenceTokenizer;
  chunkLengthSchedule?: number[];
  enableSsmlParsing?: boolean;
  enableLogging?: boolean;
  inactivityTimeout?: number;
  syncAlignment?: boolean;
  applyTextNormalization?: 'auto' | 'on' | 'off';
  applyLanguageTextNormalization?: boolean;
  preferredAlignment?: 'normalized' | 'original';
  autoMode?: boolean;
  pronunciationDictionaryLocators?: PronunciationDictionaryLocator[];
}

// Internal options type with resolved defaults
interface ResolvedTTSOptions {
  apiKey: string;
  voiceId: string;
  voiceSettings?: VoiceSettings;
  model: TTSModels | string;
  language?: string;
  baseURL: string;
  encoding: TTSEncoding;
  sampleRate: number;
  streamingLatency?: number;
  wordTokenizer: tokenize.WordTokenizer | tokenize.SentenceTokenizer;
  chunkLengthSchedule?: number[];
  enableSsmlParsing: boolean;
  enableLogging: boolean;
  inactivityTimeout: number;
  syncAlignment: boolean;
  applyTextNormalization: 'auto' | 'on' | 'off';
  applyLanguageTextNormalization?: boolean;
  preferredAlignment: 'normalized' | 'original';
  autoMode: boolean;
  pronunciationDictionaryLocators?: PronunciationDictionaryLocator[];
}

// Internal types for connection management
interface SynthesizeContent {
  contextId: string;
  text: string;
  flush: boolean;
}

interface CloseContext {
  contextId: string;
}

interface StreamData {
  stream: SynthesizeStream;
  waiter: {
    resolve: (value: void) => void;
    reject: (error: Error) => void;
  };
  textBuffer: string;
  startTimesMs: number[];
  durationsMs: number[];
  /** First word offset for timestamp normalization (removes leading silence) */
  firstWordOffsetMs: number | null;
  timeoutMs: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  terminate: () => void;
}

type ConnectionMessage = SynthesizeContent | CloseContext;

// Helper Functions

function sampleRateFromFormat(encoding: TTSEncoding): number {
  const split = encoding.split('_');
  return parseInt(split[1]!, 10);
}

function synthesizeUrl(opts: ResolvedTTSOptions): string {
  const { baseURL, voiceId, encoding, streamingLatency } = opts;
  let url = `${baseURL}/text-to-speech/${voiceId}/stream?output_format=${encoding}&enable_logging=${String(opts.enableLogging).toLowerCase()}`;
  if (streamingLatency !== undefined) {
    url += `&optimize_streaming_latency=${streamingLatency}`;
  }
  return url;
}

function dialogueSynthesizeUrl(opts: ResolvedTTSOptions): string {
  return `${opts.baseURL}/text-to-dialogue/stream?output_format=${opts.encoding}&enable_logging=${String(opts.enableLogging).toLowerCase()}`;
}

function multiStreamUrl(opts: ResolvedTTSOptions): string {
  const baseURL = opts.baseURL.replace('https://', 'wss://').replace('http://', 'ws://');
  const params: string[] = [];
  params.push(`model_id=${opts.model}`);
  params.push(`output_format=${opts.encoding}`);
  if (opts.language) {
    params.push(`language_code=${getBaseLanguage(opts.language)}`);
  }
  params.push(`enable_ssml_parsing=${opts.enableSsmlParsing}`);
  params.push(`enable_logging=${opts.enableLogging}`);
  params.push(`inactivity_timeout=${opts.inactivityTimeout}`);
  params.push(`apply_text_normalization=${opts.applyTextNormalization}`);
  if (opts.applyLanguageTextNormalization !== undefined) {
    params.push(`apply_language_text_normalization=${opts.applyLanguageTextNormalization}`);
  }
  if (opts.syncAlignment) {
    params.push('sync_alignment=true');
  }
  if (opts.autoMode !== undefined) {
    params.push(`auto_mode=${opts.autoMode}`);
  }
  return `${baseURL}/text-to-speech/${opts.voiceId}/multi-stream-input?${params.join('&')}`;
}

function dialogueMultiStreamUrl(opts: ResolvedTTSOptions): string {
  const baseURL = opts.baseURL.replace('https://', 'wss://').replace('http://', 'ws://');
  const params = [
    `model_id=${opts.model}`,
    `output_format=${opts.encoding}`,
    `enable_logging=${opts.enableLogging}`,
    `apply_text_normalization=${opts.applyTextNormalization}`,
  ];
  if (opts.language) {
    params.splice(2, 0, `language_code=${getBaseLanguage(opts.language)}`);
  }
  if (opts.syncAlignment) {
    params.push('sync_alignment=true');
  }
  return `${baseURL}/text-to-dialogue/multi-stream-input?${params.join('&')}`;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

function dialogueVoiceSettings(
  settings: Partial<VoiceSettings> | undefined,
): Partial<VoiceSettings> | undefined {
  if (!settings) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(settings).filter(([key]) =>
      DIALOGUE_VOICE_SETTINGS_FIELDS.has(key as keyof VoiceSettings),
    ),
  ) as Partial<VoiceSettings>;
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function pronunciationDictionaryLocators(opts: ResolvedTTSOptions) {
  return opts.pronunciationDictionaryLocators?.map((locator) => ({
    pronunciation_dictionary_id: locator.pronunciation_dictionary_id,
    version_id: locator.version_id,
  }));
}

/**
 * Convert alignment data to timed words.
 * Returns the timed words and remaining text buffer.
 *
 * @param firstWordOffsetMs - Optional offset to normalize timestamps (subtract from all).
 *   ElevenLabs returns absolute timestamps from the start of TTS audio, which may include
 *   leading silence. By normalizing to 0, we ensure proper sync with the synchronizer.
 */
function toTimedWords(
  text: string,
  startTimesMs: number[],
  durationsMs: number[],
  flush: boolean = false,
  firstWordOffsetMs: number = 0,
): [TimedString[], string] {
  if (!text || startTimesMs.length === 0 || durationsMs.length === 0) {
    return [[], text || ''];
  }

  const lastStartTime = startTimesMs[startTimesMs.length - 1]!;
  const lastDuration = durationsMs[durationsMs.length - 1]!;
  const timestamps = [...startTimesMs, lastStartTime + lastDuration];

  const words = tokenize.basic.splitWords(text, false);
  const timedWords: TimedString[] = [];

  if (words.length === 0) {
    return [[], text];
  }

  const startIndices = words.map((w) => w[1]);
  let end = 0;

  // We don't know if the last word is complete, always leave it as remaining
  for (let i = 0; i < startIndices.length - 1; i++) {
    const start = startIndices[i]!;
    const nextStart = startIndices[i + 1]!;
    end = nextStart;
    // Normalize timestamps by subtracting the first word offset
    const startT = Math.max(0, (timestamps[start] ?? 0) - firstWordOffsetMs) / 1000;
    const endT = Math.max(0, (timestamps[nextStart] ?? 0) - firstWordOffsetMs) / 1000;
    timedWords.push(
      createTimedString({
        text: text.slice(start, nextStart),
        startTime: startT,
        endTime: endT,
      }),
    );
  }

  if (flush && words.length > 0) {
    const lastWordStart = startIndices[startIndices.length - 1]!;
    const startT = Math.max(0, (timestamps[lastWordStart] ?? 0) - firstWordOffsetMs) / 1000;
    const endT = Math.max(0, (timestamps[timestamps.length - 1] ?? 0) - firstWordOffsetMs) / 1000;
    timedWords.push(
      createTimedString({
        text: text.slice(lastWordStart),
        startTime: startT,
        endTime: endT,
      }),
    );
    end = text.length;
  } else if (words.length > 0) {
    end = startIndices[startIndices.length - 1]!;
  }

  return [timedWords, text.slice(end)];
}

class Connection {
  #opts: ResolvedTTSOptions;
  #ws: WebSocket | null = null;
  #isCurrent = true;
  #activeContexts = new Set<string>();
  #inputQueue: ConnectionMessage[] = [];
  #contextData = new Map<string, StreamData>();
  #sendTask: Promise<void> | null = null;
  #recvTask: Promise<void> | null = null;
  #closed = false;
  #logger = log();
  #inputQueueResolver: (() => void) | null = null;
  #closingContexts = new Set<string>();
  #lastContextSend = new Map<string, number>();

  constructor(opts: ResolvedTTSOptions) {
    this.#opts = opts;
  }

  get voiceId(): string {
    return this.#opts.voiceId;
  }

  get isCurrent(): boolean {
    return this.#isCurrent;
  }

  get closed(): boolean {
    return this.#closed;
  }

  markNonCurrent(): void {
    this.#isCurrent = false;
  }

  async connect(): Promise<void> {
    if (this.#ws || this.#closed) {
      return;
    }

    const url = isDialogueModel(this.#opts.model)
      ? dialogueMultiStreamUrl(this.#opts)
      : multiStreamUrl(this.#opts);
    const headers = { [AUTHORIZATION_HEADER]: this.#opts.apiKey };

    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url, { headers });

      this.#ws.on('open', () => {
        this.#sendTask = this.#sendLoop();
        this.#recvTask = this.#recvLoop();
        resolve();
      });

      this.#ws.on('error', (error) => {
        this.#logger.error({ error }, 'WebSocket connection error');
        reject(new APIConnectionError({ message: `WebSocket error: ${error.message}` }));
      });
    });
  }

  registerStream(
    stream: SynthesizeStream,
    waiter: { resolve: (value: void) => void; reject: (error: Error) => void },
    timeoutMs: number,
    terminate: () => void,
  ): void {
    const contextId = stream.contextId;
    this.#contextData.set(contextId, {
      stream,
      waiter,
      textBuffer: '',
      startTimesMs: [],
      durationsMs: [],
      firstWordOffsetMs: null,
      timeoutMs,
      terminate,
    });
  }

  unregisterStream(contextId: string): void {
    const ctx = this.#contextData.get(contextId);
    if (ctx?.timeoutTimer) clearTimeout(ctx.timeoutTimer);
    this.#contextData.delete(contextId);
  }

  sendContent(content: SynthesizeContent): void {
    if (this.#closed || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new APIConnectionError({ message: 'WebSocket connection is closed' });
    }
    this.#inputQueue.push(content);
    this.#inputQueueResolver?.();
  }

  closeContext(contextId: string): void {
    if (this.#closed || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new APIConnectionError({ message: 'WebSocket connection is closed' });
    }
    this.#inputQueue.push({ contextId });
    this.#inputQueueResolver?.();
  }

  #nextKeepAliveDelay(): number {
    const now = performance.now();
    const eligible = [...this.#activeContexts].filter(
      (contextId) => !this.#closingContexts.has(contextId),
    );
    if (eligible.length === 0) return DIALOGUE_KEEP_ALIVE_INTERVAL;
    return Math.max(
      0,
      Math.min(
        ...eligible.map(
          (contextId) =>
            (this.#lastContextSend.get(contextId) ?? now) + DIALOGUE_KEEP_ALIVE_INTERVAL - now,
        ),
      ),
    );
  }

  async #sendDueKeepAlives(): Promise<void> {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    for (const contextId of this.#activeContexts) {
      if (this.#closingContexts.has(contextId)) continue;
      const lastSent = this.#lastContextSend.get(contextId);
      if (lastSent === undefined || now - lastSent >= DIALOGUE_KEEP_ALIVE_INTERVAL) {
        this.#ws.send(JSON.stringify({ context_id: contextId, keep_alive: true }));
        this.#lastContextSend.set(contextId, now);
      }
    }
  }

  async #waitForInput(timeout?: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        if (this.#inputQueueResolver === done) this.#inputQueueResolver = null;
        resolve();
      };
      this.#inputQueueResolver = done;
      if (timeout !== undefined) timer = setTimeout(done, timeout);
    });
  }

  async #sendLoop(): Promise<void> {
    const dialogue = isDialogueModel(this.#opts.model);
    try {
      while (!this.#closed) {
        if (this.#inputQueue.length === 0) {
          await this.#waitForInput(dialogue ? this.#nextKeepAliveDelay() : undefined);
        }

        if (this.#closed) break;

        const msg = this.#inputQueue.shift();
        if (!msg) {
          if (dialogue) await this.#sendDueKeepAlives();
          continue;
        }

        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
          break;
        }

        if ('text' in msg) {
          // SynthesizeContent
          const content = msg as SynthesizeContent;
          const isNewContext = !this.#activeContexts.has(content.contextId);

          if (isNewContext) {
            const voiceSettings = this.#opts.voiceSettings
              ? stripUndefined(this.#opts.voiceSettings)
              : {};

            const initPkt: Record<string, unknown> = dialogue
              ? {
                  context_id: content.contextId,
                  voices: [this.#opts.voiceId],
                }
              : {
                  text: ' ',
                  voice_settings: voiceSettings,
                  context_id: content.contextId,
                };

            if (dialogue) {
              const settings = dialogueVoiceSettings(voiceSettings);
              if (settings) initPkt.voice_settings = settings;
            } else if (this.#opts.chunkLengthSchedule) {
              initPkt.generation_config = {
                chunk_length_schedule: this.#opts.chunkLengthSchedule,
              };
            }

            const locators = pronunciationDictionaryLocators(this.#opts);
            if (locators) {
              initPkt.pronunciation_dictionary_locators = locators;
            }

            const initPktStr = JSON.stringify(initPkt);
            this.#ws.send(initPktStr);
            this.#activeContexts.add(content.contextId);
          }

          const pkt: Record<string, unknown> = dialogue
            ? {
                context_id: content.contextId,
                inputs: [{ text: content.text, voice_id: this.#opts.voiceId }],
              }
            : {
                text: content.text,
                context_id: content.contextId,
              };
          if (content.flush) {
            pkt.flush = true;
          }

          const pktStr = JSON.stringify(pkt);
          const ctx = this.#contextData.get(content.contextId);
          if (ctx && !ctx.timeoutTimer) {
            ctx.timeoutTimer = setTimeout(() => {
              ctx.waiter.reject(
                new APITimeoutError({
                  message: `${dialogue ? '11labs text-to-dialogue' : '11labs tts'} timed out after ${ctx.timeoutMs}ms`,
                  options: { retryable: false },
                }),
              );
              ctx.terminate();
              this.#cleanupContext(content.contextId);
            }, ctx.timeoutMs);
          }
          this.#ws.send(pktStr);
          if (dialogue) this.#lastContextSend.set(content.contextId, performance.now());
        } else {
          // CloseContext
          const closeMsg = msg as CloseContext;
          if (this.#activeContexts.has(closeMsg.contextId)) {
            if (dialogue) this.#closingContexts.add(closeMsg.contextId);
            const closePkt = {
              context_id: closeMsg.contextId,
              close_context: true,
            };
            const closePktStr = JSON.stringify(closePkt);
            this.#ws.send(closePktStr);
          }
        }

        if (dialogue) await this.#sendDueKeepAlives();
      }
    } catch (e) {
      if (dialogue) {
        const error = asError(e);
        this.#logger.warn(
          { exception_type: error.name, 'lk.pii.error': error.message },
          'dialogue send loop error',
        );
      } else {
        this.#logger.warn({ error: e }, 'send loop error');
      }
    } finally {
      if (!this.#closed) {
        await this.close('send');
      }
    }
  }

  async #recvLoop(): Promise<void> {
    if (!this.#ws) return;
    const dialogue = isDialogueModel(this.#opts.model);

    const messageChannel = stream.createStreamChannel<Record<string, unknown>>();

    const onMessage = (rawData: Buffer) => {
      try {
        const parsed = JSON.parse(rawData.toString());
        messageChannel.write(parsed);
      } catch (e) {
        this.#logger.warn({ error: e }, 'failed to parse WebSocket message');
      }
    };

    const onClose = (code: number) => {
      if (!this.#closed && this.#contextData.size > 0) {
        messageChannel.abort(
          new APIStatusError({
            message: dialogue
              ? 'ElevenLabs dialogue websocket connection closed unexpectedly'
              : 'ElevenLabs websocket connection closed unexpectedly',
            options: { statusCode: code },
          }),
        );
      } else {
        messageChannel.close();
      }
    };

    const onError = (error: Error) => {
      messageChannel.abort(error);
    };

    this.#ws.on('message', onMessage);
    this.#ws.on('close', onClose);
    this.#ws.on('error', onError);

    const reader = messageChannel.stream().getReader();

    try {
      while (!this.#closed) {
        const result = await reader.read();
        if (result.done || this.#closed) break;

        const data = result.value;
        const contextId = (dialogue ? data.context_id : data.contextId || data.context_id) as
          | string
          | undefined;
        const ctx = contextId ? this.#contextData.get(contextId) : undefined;

        if (data.error) {
          this.#logger.error(
            dialogue
              ? {
                  context_id: contextId,
                  'lk.pii.error': data.error,
                  'lk.pii.data': data,
                }
              : {
                  context_id: contextId,
                  error: data.error,
                  'lk.pii.data': data,
                },
            dialogue
              ? 'elevenlabs text-to-dialogue returned error'
              : 'elevenlabs tts returned error',
          );
          if (contextId) {
            if (ctx) {
              ctx.terminate();
              ctx.waiter.reject(
                new APIError(data.error as string, { retryable: dialogue ? false : true }),
              );
            }
            this.#cleanupContext(contextId);
          }
          continue;
        }

        if (!ctx) {
          if (!dialogue && data.type === 'flush_done') {
            this.#logger.debug(
              { context_id: contextId, 'lk.pii.data': data },
              'ignoring elevenlabs flush_done message for inactive context',
            );
            continue;
          }

          if (contextId) {
            this.#logger.debug(
              { context_id: contextId, 'lk.pii.data': data },
              dialogue
                ? 'ignoring elevenlabs text-to-dialogue message for inactive context'
                : 'ignoring elevenlabs message for inactive context',
            );
            if (data[dialogue ? 'is_final' : 'isFinal']) {
              this.#cleanupContext(contextId);
              if (!this.#isCurrent && this.#activeContexts.size === 0) break;
            }
          } else {
            this.#logger.warn(
              { 'lk.pii.data': data },
              dialogue
                ? 'unexpected message received from elevenlabs text-to-dialogue'
                : 'unexpected message received from elevenlabs tts',
            );
          }
          continue;
        }

        const stream = ctx.stream;

        // Process alignment data
        const alignment = dialogue
          ? (data.alignment as Record<string, unknown>)
          : this.#opts.preferredAlignment === 'normalized'
            ? (data.normalizedAlignment as Record<string, unknown>)
            : (data.alignment as Record<string, unknown>);

        if (alignment && stream) {
          const chars = alignment.chars as string[] | undefined;
          const starts = (
            dialogue
              ? alignment.char_start_times_ms
              : alignment.charStartTimesMs || alignment.charsStartTimesMs
          ) as number[] | undefined;
          const durs = (
            dialogue
              ? alignment.char_durations_ms
              : alignment.charDurationsMs || alignment.charsDurationsMs
          ) as number[] | undefined;

          if (
            chars &&
            starts &&
            durs &&
            chars.length === durs.length &&
            starts.length === durs.length
          ) {
            ctx.textBuffer += chars.join('');

            // Handle chars with multiple characters
            for (let i = 0; i < chars.length; i++) {
              const char = chars[i]!;
              const start = starts[i]!;
              const dur = durs[i]!;

              // Capture the first word's start time for normalization
              // This removes leading silence from timestamps
              if (!dialogue && ctx.firstWordOffsetMs === null && start > 0) {
                ctx.firstWordOffsetMs = start;
              }

              if (char.length > 1) {
                for (let j = 0; j < char.length - 1; j++) {
                  ctx.startTimesMs.push(start);
                  ctx.durationsMs.push(0);
                }
              }
              ctx.startTimesMs.push(start);
              ctx.durationsMs.push(dur);
            }

            const [timedWords, remainingText] = toTimedWords(
              ctx.textBuffer,
              ctx.startTimesMs,
              ctx.durationsMs,
              false,
              dialogue ? 0 : ctx.firstWordOffsetMs ?? 0,
            );

            if (timedWords.length > 0) {
              stream.pushTimedTranscript(timedWords);
            }

            ctx.textBuffer = remainingText;
            ctx.startTimesMs = ctx.startTimesMs.slice(-remainingText.length);
            ctx.durationsMs = ctx.durationsMs.slice(-remainingText.length);
          }
        }

        if (data.audio) {
          const audioData = Buffer.from(data.audio as string, 'base64');
          stream.pushAudio(audioData);
          if (ctx.timeoutTimer) {
            clearTimeout(ctx.timeoutTimer);
          }
        }

        if (data[dialogue ? 'is_final' : 'isFinal']) {
          // Flush remaining alignment data
          if (ctx.textBuffer) {
            const [timedWords] = toTimedWords(
              ctx.textBuffer,
              ctx.startTimesMs,
              ctx.durationsMs,
              true,
              dialogue ? 0 : ctx.firstWordOffsetMs ?? 0,
            );
            if (timedWords.length > 0) {
              stream.pushTimedTranscript(timedWords);
            }
          }

          stream.markDone();
          ctx.waiter.resolve();
          this.#cleanupContext(contextId!);

          if (!this.#isCurrent && this.#activeContexts.size === 0) {
            this.#logger.debug('no active contexts, shutting down connection');
            break;
          }
        }
      }
    } catch (e) {
      if (dialogue) {
        const error = asError(e);
        this.#logger.warn(
          { exception_type: error.name, 'lk.pii.error': error.message },
          'dialogue recv loop error',
        );
      } else {
        this.#logger.warn({ error: e }, 'recv loop error');
      }
      for (const ctx of this.#contextData.values()) {
        if (ctx.timeoutTimer) clearTimeout(ctx.timeoutTimer);
        ctx.terminate();
        ctx.waiter.reject(asError(e));
      }
      this.#contextData.clear();
    } finally {
      reader.releaseLock();
      this.#ws?.off('message', onMessage);
      this.#ws?.off('close', onClose);
      this.#ws?.off('error', onError);
      if (!this.#closed) {
        await this.close('recv');
      }
    }
  }

  #cleanupContext(contextId: string): void {
    this.unregisterStream(contextId);
    this.#activeContexts.delete(contextId);
    this.#closingContexts.delete(contextId);
    this.#lastContextSend.delete(contextId);
  }

  async close(caller?: 'send' | 'recv'): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#inputQueueResolver?.();

    for (const ctx of this.#contextData.values()) {
      if (ctx.timeoutTimer) clearTimeout(ctx.timeoutTimer);
      ctx.waiter.reject(new APIStatusError({ message: 'connection closed' }));
    }
    this.#contextData.clear();

    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }

    if (this.#sendTask && caller !== 'send') {
      await this.#sendTask.catch(() => {});
    }
    if (this.#recvTask && caller !== 'recv') {
      await this.#recvTask.catch(() => {});
    }
  }
}

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  #streams = new Set<SynthesizeStream>();
  #currentConnection: Connection | null = null;
  #connectionLock = new Mutex();
  #logger = log();

  label = 'elevenlabs.TTS';

  constructor(opts: TTSOptions = {}) {
    const autoMode = opts.autoMode ?? opts.chunkLengthSchedule === undefined;
    const encoding = opts.encoding ?? DEFAULT_ENCODING;
    const sampleRate = sampleRateFromFormat(encoding);
    const syncAlignment = opts.syncAlignment ?? true;

    super(sampleRate, 1, {
      streaming: true,
      alignedTranscript: syncAlignment,
    });

    const apiKey = opts.apiKey ?? process.env.ELEVEN_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ElevenLabs API key is required, either as argument or set ELEVEN_API_KEY environmental variable',
      );
    }

    let wordTokenizer = opts.wordTokenizer;
    if (!wordTokenizer) {
      wordTokenizer = autoMode
        ? new tokenize.basic.SentenceTokenizer()
        : new tokenize.basic.WordTokenizer(false);
    } else if (autoMode && !(wordTokenizer instanceof tokenize.SentenceTokenizer)) {
      this.#logger.warn(
        'autoMode is enabled, it expects full sentences or phrases, ' +
          'please provide a SentenceTokenizer instead of a WordTokenizer.',
      );
    }

    // Handle legacy options for backward compatibility
    const voiceId = opts.voiceId ?? opts.voice?.id ?? DEFAULT_VOICE_ID;
    const voiceSettings = opts.voiceSettings ?? opts.voice?.settings;
    const model = opts.model ?? opts.modelID ?? 'eleven_turbo_v2_5';
    const rawLanguage = opts.language ?? opts.languageCode;
    const language = rawLanguage ? normalizeLanguage(rawLanguage) : undefined;

    this.#opts = {
      apiKey,
      voiceId,
      voiceSettings,
      model,
      language,
      baseURL: opts.baseURL ?? API_BASE_URL_V1,
      encoding,
      sampleRate,
      streamingLatency: opts.streamingLatency,
      wordTokenizer,
      chunkLengthSchedule: opts.chunkLengthSchedule,
      enableSsmlParsing: opts.enableSsmlParsing ?? false,
      enableLogging: opts.enableLogging ?? true,
      inactivityTimeout: opts.inactivityTimeout ?? WS_INACTIVITY_TIMEOUT,
      syncAlignment: opts.syncAlignment ?? true,
      applyTextNormalization: opts.applyTextNormalization ?? 'auto',
      applyLanguageTextNormalization: opts.applyLanguageTextNormalization,
      preferredAlignment: opts.preferredAlignment ?? 'normalized',
      autoMode,
      pronunciationDictionaryLocators: opts.pronunciationDictionaryLocators,
    };
    this.#warnIfDialogueModelIgnoresOptions();
  }

  #warnIfDialogueModelIgnoresOptions(): void {
    if (!isDialogueModel(this.#opts.model)) return;
    const ignored: string[] = [];
    if (this.#opts.chunkLengthSchedule !== undefined) ignored.push('chunkLengthSchedule');
    if (this.#opts.streamingLatency !== undefined) ignored.push('streamingLatency');
    if (this.#opts.enableSsmlParsing) ignored.push('enableSsmlParsing');
    if (this.#opts.applyLanguageTextNormalization !== undefined) {
      ignored.push('applyLanguageTextNormalization');
    }
    if (this.#opts.voiceSettings) {
      for (const key of Object.keys(stripUndefined(this.#opts.voiceSettings))) {
        if (!DIALOGUE_VOICE_SETTINGS_FIELDS.has(key as keyof VoiceSettings)) {
          ignored.push(`voiceSettings.${key}`);
        }
      }
    }
    if (ignored.length > 0) {
      this.#logger.warn(
        `model '${this.#opts.model}' is synthesized via ElevenLabs' text-to-dialogue API, which does not support these options; they will be ignored: ${ignored.join(', ')}`,
      );
    }
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'ElevenLabs';
  }

  async listVoices(): Promise<Voice[]> {
    const response = await fetch(`${this.#opts.baseURL}/voices`, {
      headers: { [AUTHORIZATION_HEADER]: this.#opts.apiKey },
    });
    const data = (await response.json()) as {
      voices: { voice_id: string; name: string; category: string }[];
    };
    return data.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      category: v.category,
    }));
  }

  updateOptions(opts: {
    voiceId?: string;
    voiceSettings?: VoiceSettings;
    model?: TTSModels | string;
    language?: string;
    pronunciationDictionaryLocators?: PronunciationDictionaryLocator[];
  }): void {
    let changed = false;

    if (opts.model !== undefined && opts.model !== this.#opts.model) {
      this.#opts.model = opts.model;
      changed = true;
    }

    if (opts.voiceId !== undefined && opts.voiceId !== this.#opts.voiceId) {
      this.#opts.voiceId = opts.voiceId;
      changed = true;
    }

    if (opts.voiceSettings !== undefined) {
      this.#opts.voiceSettings = opts.voiceSettings;
      changed = true;
    }

    if (opts.language !== undefined && opts.language !== this.#opts.language) {
      this.#opts.language = normalizeLanguage(opts.language);
      changed = true;
    }

    if (opts.pronunciationDictionaryLocators !== undefined) {
      this.#opts.pronunciationDictionaryLocators = opts.pronunciationDictionaryLocators;
      changed = true;
    }

    if (changed) this.#warnIfDialogueModelIgnoresOptions();

    if (changed && this.#currentConnection) {
      this.#currentConnection.markNonCurrent();
      this.#currentConnection = null;
    }
  }

  async currentConnection(): Promise<Connection> {
    const unlock = await this.#connectionLock.lock();
    try {
      if (
        this.#currentConnection &&
        this.#currentConnection.isCurrent &&
        !this.#currentConnection.closed
      ) {
        return this.#currentConnection;
      }

      const conn = new Connection({ ...this.#opts });
      await conn.connect();
      this.#currentConnection = conn;
      return conn;
    } finally {
      unlock();
    }
  }

  synthesize(text: string): ChunkedStream {
    return new ChunkedStream(this, text, { ...this.#opts });
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const stream = new SynthesizeStream(this, { ...this.#opts }, options?.connOptions);
    this.#streams.add(stream);
    return stream;
  }

  async close(): Promise<void> {
    for (const stream of this.#streams) {
      stream.close();
    }
    this.#streams.clear();

    if (this.#currentConnection) {
      await this.#currentConnection.close();
      this.#currentConnection = null;
    }
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  #tts: TTS;
  #opts: ResolvedTTSOptions;
  #logger = log();

  label = 'elevenlabs.ChunkedStream';

  constructor(tts: TTS, text: string, opts: ResolvedTTSOptions) {
    super(text, tts);
    this.#tts = tts;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const voiceSettings = this.#opts.voiceSettings
      ? stripUndefined(this.#opts.voiceSettings)
      : undefined;
    const extraParams: Record<string, string | boolean> = {};
    if (this.#opts.language) {
      extraParams.language_code = getBaseLanguage(this.#opts.language);
    }
    if (this.#opts.applyLanguageTextNormalization !== undefined) {
      extraParams.apply_language_text_normalization = this.#opts.applyLanguageTextNormalization;
    }

    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, 1);

    try {
      const dialogue = isDialogueModel(this.#opts.model);
      const settings = dialogueVoiceSettings(voiceSettings);
      const body = dialogue
        ? {
            inputs: [{ text: this.inputText, voice_id: this.#opts.voiceId }],
            model_id: this.#opts.model,
            apply_text_normalization: this.#opts.applyTextNormalization,
            ...(settings ? { settings } : {}),
            ...(this.#opts.language ? { language_code: getBaseLanguage(this.#opts.language) } : {}),
            ...(this.#opts.pronunciationDictionaryLocators
              ? {
                  pronunciation_dictionary_locators: pronunciationDictionaryLocators(this.#opts),
                }
              : {}),
          }
        : {
            text: this.inputText,
            model_id: this.#opts.model,
            voice_settings: voiceSettings,
            apply_text_normalization: this.#opts.applyTextNormalization,
            ...extraParams,
          };
      const response = await fetch(
        dialogue ? dialogueSynthesizeUrl(this.#opts) : synthesizeUrl(this.#opts),
        {
          method: 'POST',
          headers: {
            [AUTHORIZATION_HEADER]: this.#opts.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: this.abortSignal,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new APIStatusError({
          message: `ElevenLabs API error: ${errorText}`,
          options: { statusCode: response.status },
        });
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('audio/')) {
        const content = await response.text();
        throw new APIError(`ElevenLabs returned non-audio data: ${content}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new APIError('No response body');
      }

      let lastFrame: AudioFrame | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const frame of bstream.write(value)) {
          if (lastFrame) {
            this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final: false });
          }
          lastFrame = frame;
        }
      }

      // Flush remaining data
      for (const frame of bstream.flush()) {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final: false });
        }
        lastFrame = frame;
      }

      if (lastFrame) {
        this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final: true });
      }
    } catch (e) {
      if (e instanceof APIError) {
        throw e;
      }
      if (e instanceof Error && e.name === 'AbortError') {
        return;
      }
      throw new APIConnectionError({ message: `Connection error: ${e}` });
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #tts: TTS;
  #opts: ResolvedTTSOptions;
  #contextId: string;
  #sentTokenizerStream: tokenize.SentenceStream | tokenize.WordStream;
  #logger = log();
  #audioQueue: Buffer[] = [];
  #timedTranscriptQueue: TimedString[] = [];
  #streamDone = false;

  label = 'elevenlabs.SynthesizeStream';

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#tts = tts;
    this.#opts = opts;
    this.#contextId = shortuuid();
    this.#sentTokenizerStream = this.#opts.wordTokenizer.stream();
  }

  get contextId(): string {
    return this.#contextId;
  }

  pushAudio(data: Buffer): void {
    // Don't push if stream is closed/aborted
    if (this.closed || this.abortController.signal.aborted) {
      return;
    }
    this.#audioQueue.push(data);
  }

  pushTimedTranscript(timedWords: TimedString[]): void {
    this.#timedTranscriptQueue.push(...timedWords);
  }

  markDone(): void {
    this.#streamDone = true;
  }

  protected async run(): Promise<void> {
    const requestId = this.#contextId;
    const segmentId = this.#contextId;
    const bstream = new AudioByteStream(this.#opts.sampleRate, 1);

    let connection: Connection;
    try {
      connection = await this.#tts.currentConnection();
    } catch (e) {
      throw new APIConnectionError({ message: 'could not connect to ElevenLabs' });
    }

    let waiterReject: ((reason: Error) => void) | undefined;
    const waiterPromise = new Promise<void>((resolve, reject) => {
      waiterReject = reject;
      connection.registerStream(this, { resolve, reject }, this.connOptions.timeoutMs, () => {
        this.#streamDone = true;
        this.#sentTokenizerStream.close();
        if (!this.input.closed) this.input.close();
      });
    });
    let contextClosed = false;

    const closeContext = (suppressErrors = false) => {
      if (contextClosed) {
        return;
      }

      if (suppressErrors) {
        contextClosed = true;
        try {
          connection.closeContext(this.#contextId);
        } catch {
          // The connection may already be closed during cancellation.
        }
        return;
      }

      connection.closeContext(this.#contextId);
      contextClosed = true;
    };

    // Handle abort - reject the waiter so Promise.all can complete
    const abortHandler = () => {
      if (waiterReject) {
        waiterReject(new Error('Stream aborted'));
      }
    };
    this.abortController.signal.addEventListener('abort', abortHandler, { once: true });

    const inputTask = async () => {
      for await (const data of this.input) {
        if (this.abortController.signal.aborted) break;
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.#sentTokenizerStream.flush();
          continue;
        }
        this.#sentTokenizerStream.pushText(data);
      }
      this.#sentTokenizerStream.endInput();
    };

    const sentenceStreamTask = async () => {
      const flushOnChunk =
        this.#opts.wordTokenizer instanceof tokenize.SentenceTokenizer && this.#opts.autoMode;

      let xmlContent: string[] = [];

      for await (const data of this.#sentTokenizerStream) {
        if (this.abortController.signal.aborted) break;

        let text = data.token;
        const xmlStartTokens = ['<phoneme', '<break'];
        const xmlEndTokens = ['</phoneme>', '/>'];

        if (
          (this.#opts.enableSsmlParsing &&
            xmlStartTokens.some((start) => text.startsWith(start))) ||
          xmlContent.length > 0
        ) {
          xmlContent.push(text);

          if (xmlEndTokens.some((end) => text.includes(end))) {
            text = xmlContent.join(' ');
            xmlContent = [];
          } else {
            continue;
          }
        }

        const formattedText = `${text} `; // must always end with a space
        this.markStarted();
        connection.sendContent({
          contextId: this.#contextId,
          text: formattedText,
          flush: flushOnChunk,
        });
      }

      if (xmlContent.length > 0) {
        this.#logger.warn('ElevenLabs stream ended with incomplete xml content');
      }

      // Send final empty text to signal end of input
      connection.sendContent({ contextId: this.#contextId, text: '', flush: true });
      closeContext();
    };

    const audioProcessTask = async () => {
      let lastFrame: AudioFrame | undefined;
      let pendingTimedTranscripts: TimedString[] = [];

      const sendLastFrame = (final: boolean) => {
        if (lastFrame) {
          // Include timedTranscripts with the audio frame
          this.queue.put({
            requestId,
            segmentId,
            frame: lastFrame,
            final,
            timedTranscripts:
              pendingTimedTranscripts.length > 0 ? pendingTimedTranscripts : undefined,
          });
          lastFrame = undefined;
          pendingTimedTranscripts = [];
        }
      };

      while (!this.abortController.signal.aborted) {
        // Drain timed transcript queue
        while (this.#timedTranscriptQueue.length > 0) {
          pendingTimedTranscripts.push(this.#timedTranscriptQueue.shift()!);
        }

        // Process audio queue
        while (this.#audioQueue.length > 0) {
          const audioData = this.#audioQueue.shift()!;
          for (const frame of bstream.write(audioData)) {
            sendLastFrame(false);
            lastFrame = frame;
          }
        }

        // Exit when stream is done and queue is empty
        if (this.#streamDone && this.#audioQueue.length === 0) {
          break;
        }

        // Small delay to avoid busy waiting
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Drain any remaining timed transcripts
      while (this.#timedTranscriptQueue.length > 0) {
        pendingTimedTranscripts.push(this.#timedTranscriptQueue.shift()!);
      }

      // Flush remaining
      for (const frame of bstream.flush()) {
        sendLastFrame(false);
        lastFrame = frame;
      }

      sendLastFrame(true);
    };

    try {
      await Promise.all([inputTask(), sentenceStreamTask(), audioProcessTask(), waiterPromise]);
    } catch (e) {
      // If aborted, this is a normal termination - don't throw
      if (this.abortController.signal.aborted) {
        return;
      }

      if (e instanceof APIError) {
        throw e;
      }
      throw new APIStatusError({ message: 'Could not synthesize' });
    } finally {
      connection.unregisterStream(this.#contextId);
      closeContext(true);
      // Clean up abort listener
      this.abortController.signal.removeEventListener('abort', abortHandler);
    }
  }

  close(): void {
    // Clear audio buffers to prevent memory leak
    this.#audioQueue.length = 0;
    this.#timedTranscriptQueue.length = 0;
    this.#streamDone = true;
    this.#sentTokenizerStream.close();
    super.close();
  }
}
