// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  log,
  shortuuid,
  tokenize,
  tts,
  type voice,
} from '@livekit/agents';
import { Mutex } from '@livekit/mutex';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import type { TTSEncoding, TTSModels } from './models.js';

type TimedString = voice.TimedString;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_VOICE_ID = 'bIHbv24MWmeRgasZH58o';
const API_BASE_URL_V1 = 'https://api.elevenlabs.io/v1';
const AUTHORIZATION_HEADER = 'xi-api-key';
const WS_INACTIVITY_TIMEOUT = 180;
// Note: MP3 has lower TTFB but requires decoding. PCM is raw and can be used directly.
const DEFAULT_ENCODING: TTSEncoding = 'pcm_22050';

// ============================================================================
// Types and Interfaces
// ============================================================================

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
  timeoutTimer?: ReturnType<typeof setTimeout>;
  completionTimer?: ReturnType<typeof setTimeout>;
  audioReceived: boolean;
  contextClosed: boolean;
  textBuffer: string;
  startTimesMs: number[];
  durationsMs: number[];
}

type ConnectionMessage = SynthesizeContent | CloseContext;

// ============================================================================
// Helper Functions
// ============================================================================

function sampleRateFromFormat(encoding: TTSEncoding): number {
  const split = encoding.split('_');
  return parseInt(split[1]!, 10);
}

function synthesizeUrl(opts: ResolvedTTSOptions): string {
  const { baseURL, voiceId, model, encoding, streamingLatency } = opts;
  let url = `${baseURL}/text-to-speech/${voiceId}/stream?model_id=${model}&output_format=${encoding}`;
  if (streamingLatency !== undefined) {
    url += `&optimize_streaming_latency=${streamingLatency}`;
  }
  return url;
}

function multiStreamUrl(opts: ResolvedTTSOptions): string {
  const baseURL = opts.baseURL.replace('https://', 'wss://').replace('http://', 'ws://');
  const params: string[] = [];
  params.push(`model_id=${opts.model}`);
  params.push(`output_format=${opts.encoding}`);
  if (opts.language) {
    params.push(`language_code=${opts.language}`);
  }
  params.push(`enable_ssml_parsing=${opts.enableSsmlParsing}`);
  params.push(`enable_logging=${opts.enableLogging}`);
  params.push(`inactivity_timeout=${opts.inactivityTimeout}`);
  params.push(`apply_text_normalization=${opts.applyTextNormalization}`);
  if (opts.syncAlignment) {
    params.push('sync_alignment=true');
  }
  if (opts.autoMode !== undefined) {
    params.push(`auto_mode=${opts.autoMode}`);
  }
  return `${baseURL}/text-to-speech/${opts.voiceId}/multi-stream-input?${params.join('&')}`;
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

/**
 * Convert alignment data to timed words.
 * Returns the timed words and remaining text buffer.
 */
function toTimedWords(
  text: string,
  startTimesMs: number[],
  durationsMs: number[],
  flush: boolean = false,
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
    const startT = (timestamps[start] ?? 0) / 1000;
    const endT = (timestamps[nextStart] ?? 0) / 1000;
    timedWords.push({
      text: text.slice(start, nextStart),
      startTime: startT,
      endTime: endT,
    });
  }

  if (flush && words.length > 0) {
    const lastWordStart = startIndices[startIndices.length - 1]!;
    const startT = (timestamps[lastWordStart] ?? 0) / 1000;
    const endT = (timestamps[timestamps.length - 1] ?? 0) / 1000;
    timedWords.push({
      text: text.slice(lastWordStart),
      startTime: startT,
      endTime: endT,
    });
    end = text.length;
  } else if (words.length > 0) {
    end = startIndices[startIndices.length - 1]!;
  }

  return [timedWords, text.slice(end)];
}

// ============================================================================
// Connection Class (Internal)
// ============================================================================

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

    const url = multiStreamUrl(this.#opts);
    const headers = { [AUTHORIZATION_HEADER]: this.#opts.apiKey };

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'tts.ts:Connection.connect',
        message: 'Connecting to WebSocket',
        data: { url: url.replace(/xi-api-key=[^&]+/, 'xi-api-key=***') },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'H1',
      }),
    }).catch(() => {});
    // #endregion

    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(url, { headers });

      this.#ws.on('open', () => {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'tts.ts:Connection.connect',
            message: 'WebSocket connected successfully',
            data: {},
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'H1',
          }),
        }).catch(() => {});
        // #endregion
        this.#sendTask = this.#sendLoop();
        this.#recvTask = this.#recvLoop();
        resolve();
      });

      this.#ws.on('error', (error) => {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'tts.ts:Connection.connect',
            message: 'WebSocket error',
            data: { error: error.message },
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'H1',
          }),
        }).catch(() => {});
        // #endregion
        this.#logger.error({ error }, 'WebSocket connection error');
        reject(new APIConnectionError({ message: `WebSocket error: ${error.message}` }));
      });
    });
  }

  registerStream(
    stream: SynthesizeStream,
    waiter: { resolve: (value: void) => void; reject: (error: Error) => void },
  ): void {
    const contextId = stream.contextId;
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'tts.ts:Connection.registerStream',
        message: 'Registering stream',
        data: { contextId },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'H2',
      }),
    }).catch(() => {});
    // #endregion
    this.#contextData.set(contextId, {
      stream,
      waiter,
      audioReceived: false,
      contextClosed: false,
      textBuffer: '',
      startTimesMs: [],
      durationsMs: [],
    });
  }

  sendContent(content: SynthesizeContent): void {
    if (this.#closed || !this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new APIConnectionError({ message: 'WebSocket connection is closed' });
    }
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'tts.ts:Connection.sendContent',
        message: 'Sending content',
        data: { contextId: content.contextId, textLen: content.text.length, flush: content.flush },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'H4',
      }),
    }).catch(() => {});
    // #endregion
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

  async #sendLoop(): Promise<void> {
    try {
      while (!this.#closed) {
        // Wait for messages in queue
        if (this.#inputQueue.length === 0) {
          await new Promise<void>((resolve) => {
            this.#inputQueueResolver = resolve;
          });
          this.#inputQueueResolver = null;
        }

        if (this.#closed) break;

        const msg = this.#inputQueue.shift();
        if (!msg) continue;

        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
          break;
        }

        if ('text' in msg) {
          // SynthesizeContent
          const content = msg as SynthesizeContent;
          const isNewContext = !this.#activeContexts.has(content.contextId);

          // If not current and this is a new context, ignore it
          if (!this.#isCurrent && isNewContext) {
            continue;
          }

          if (isNewContext) {
            const voiceSettings = this.#opts.voiceSettings
              ? stripUndefined(this.#opts.voiceSettings)
              : {};

            const initPkt: Record<string, unknown> = {
              text: ' ',
              voice_settings: voiceSettings,
              context_id: content.contextId,
            };

            if (this.#opts.pronunciationDictionaryLocators) {
              initPkt.pronunciation_dictionary_locators =
                this.#opts.pronunciationDictionaryLocators.map((locator) => ({
                  pronunciation_dictionary_id: locator.pronunciation_dictionary_id,
                  version_id: locator.version_id,
                }));
            }

            this.#ws.send(JSON.stringify(initPkt));
            this.#activeContexts.add(content.contextId);
          }

          const pkt: Record<string, unknown> = {
            text: content.text,
            context_id: content.contextId,
          };
          if (content.flush) {
            pkt.flush = true;
          }

          // Start timeout timer for this context
          this.#startTimeoutTimer(content.contextId);

          this.#ws.send(JSON.stringify(pkt));
        } else {
          // CloseContext
          const closeMsg = msg as CloseContext;
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'tts.ts:Connection.sendLoop',
              message: 'Processing closeContext',
              data: {
                contextId: closeMsg.contextId,
                isActive: this.#activeContexts.has(closeMsg.contextId),
              },
              timestamp: Date.now(),
              sessionId: 'debug-session',
              hypothesisId: 'H9-closeContext',
            }),
          }).catch(() => {});
          // #endregion
          if (this.#activeContexts.has(closeMsg.contextId)) {
            const closePkt = {
              context_id: closeMsg.contextId,
              close_context: true,
            };
            const closePktStr = JSON.stringify(closePkt);
            this.#ws.send(closePktStr);

            // Mark context as closed and potentially start completion timer
            const ctx = this.#contextData.get(closeMsg.contextId);
            if (ctx) {
              ctx.contextClosed = true;
              this.#maybeStartCompletionTimer(closeMsg.contextId);
            }

            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'tts.ts:Connection.sendLoop',
                message: 'Sent close_context packet',
                data: { contextId: closeMsg.contextId, packet: closePktStr },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'H9-closeContext',
              }),
            }).catch(() => {});
            // #endregion
          }
        }
      }
    } catch (e) {
      this.#logger.warn({ error: e }, 'send loop error');
    } finally {
      if (!this.#closed) {
        await this.close();
      }
    }
  }

  async #recvLoop(): Promise<void> {
    try {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'tts.ts:Connection.recvLoop',
          message: 'recvLoop started',
          data: {},
          timestamp: Date.now(),
          sessionId: 'debug-session',
          hypothesisId: 'H10-recvLoop',
        }),
      }).catch(() => {});
      // #endregion
      while (!this.#closed && this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        const data = await new Promise<Record<string, unknown> | null>((resolve, reject) => {
          if (!this.#ws) {
            resolve(null);
            return;
          }

          const onMessage = (rawData: Buffer) => {
            cleanup();
            try {
              resolve(JSON.parse(rawData.toString()));
            } catch (e) {
              reject(e);
            }
          };

          const onClose = () => {
            cleanup();
            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'tts.ts:Connection.recvLoop.onClose',
                message: 'WebSocket closed in recv loop',
                data: { closed: this.#closed, contextDataSize: this.#contextData.size },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'H11-wsClose',
              }),
            }).catch(() => {});
            // #endregion
            if (!this.#closed && this.#contextData.size > 0) {
              this.#logger.warn('websocket closed unexpectedly');
            }
            resolve(null);
          };

          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };

          const cleanup = () => {
            this.#ws?.off('message', onMessage);
            this.#ws?.off('close', onClose);
            this.#ws?.off('error', onError);
          };

          this.#ws.once('message', onMessage);
          this.#ws.once('close', onClose);
          this.#ws.once('error', onError);
        });

        if (!data) break;

        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'tts.ts:Connection.recvLoop',
            message: 'Received WS message',
            data: {
              contextId: data.contextId,
              hasAudio: !!data.audio,
              isFinal: !!data.isFinal,
              hasError: !!data.error,
              keys: Object.keys(data),
            },
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'H8-wsMessage',
          }),
        }).catch(() => {});
        // #endregion

        const contextId = data.contextId as string | undefined;
        const ctx = contextId ? this.#contextData.get(contextId) : undefined;

        if (data.error) {
          this.#logger.error(
            { context_id: contextId, error: data.error, data },
            'elevenlabs tts returned error',
          );
          if (contextId) {
            if (ctx) {
              ctx.waiter.reject(new APIError(data.error as string));
            }
            this.#cleanupContext(contextId);
          }
          continue;
        }

        if (!ctx) {
          this.#logger.warn({ data }, 'unexpected message received from elevenlabs tts');
          continue;
        }

        const stream = ctx.stream;

        // Process alignment data
        const alignment =
          this.#opts.preferredAlignment === 'normalized'
            ? (data.normalizedAlignment as Record<string, unknown>)
            : (data.alignment as Record<string, unknown>);

        if (alignment && stream) {
          const chars = alignment.chars as string[] | undefined;
          const starts = (alignment.charStartTimesMs || alignment.charsStartTimesMs) as
            | number[]
            | undefined;
          const durs = (alignment.charDurationsMs || alignment.charsDurationsMs) as
            | number[]
            | undefined;

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
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'tts.ts:Connection.recvLoop',
              message: 'Received audio data',
              data: { contextId, audioLen: audioData.length },
              timestamp: Date.now(),
              sessionId: 'debug-session',
              hypothesisId: 'H3',
            }),
          }).catch(() => {});
          // #endregion
          stream.pushAudio(audioData);
          if (ctx.timeoutTimer) {
            clearTimeout(ctx.timeoutTimer);
            ctx.timeoutTimer = undefined;
          }

          // Track that we've received audio and potentially start completion timer
          ctx.audioReceived = true;
          this.#maybeStartCompletionTimer(contextId!);
        }

        if (data.isFinal) {
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'tts.ts:Connection.recvLoop',
              message: 'Received isFinal',
              data: { contextId },
              timestamp: Date.now(),
              sessionId: 'debug-session',
              hypothesisId: 'H7-isFinal',
            }),
          }).catch(() => {});
          // #endregion

          // Flush remaining alignment data
          if (ctx.textBuffer) {
            const [timedWords] = toTimedWords(
              ctx.textBuffer,
              ctx.startTimesMs,
              ctx.durationsMs,
              true,
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
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'tts.ts:Connection.recvLoop',
          message: 'recvLoop exited while loop',
          data: {
            closed: this.#closed,
            wsState: this.#ws?.readyState,
            activeContexts: this.#activeContexts.size,
          },
          timestamp: Date.now(),
          sessionId: 'debug-session',
          hypothesisId: 'H10-recvLoop',
        }),
      }).catch(() => {});
      // #endregion
    } catch (e) {
      this.#logger.warn({ error: e }, 'recv loop error');
      for (const ctx of this.#contextData.values()) {
        ctx.waiter.reject(e instanceof Error ? e : new Error(String(e)));
        if (ctx.timeoutTimer) {
          clearTimeout(ctx.timeoutTimer);
        }
      }
      this.#contextData.clear();
    } finally {
      if (!this.#closed) {
        await this.close();
      }
    }
  }

  #cleanupContext(contextId: string): void {
    const ctx = this.#contextData.get(contextId);
    if (ctx?.timeoutTimer) {
      clearTimeout(ctx.timeoutTimer);
    }
    if (ctx?.completionTimer) {
      clearTimeout(ctx.completionTimer);
    }
    this.#contextData.delete(contextId);
    this.#activeContexts.delete(contextId);
  }

  #startTimeoutTimer(contextId: string): void {
    const ctx = this.#contextData.get(contextId);
    if (!ctx || ctx.timeoutTimer) {
      return;
    }

    const timeout = 30000; // 30 seconds default timeout

    ctx.timeoutTimer = setTimeout(() => {
      ctx.waiter.reject(
        new APITimeoutError({ message: `11labs tts timed out after ${timeout}ms` }),
      );
      this.#cleanupContext(contextId);
    }, timeout);
  }

  #maybeStartCompletionTimer(contextId: string): void {
    const ctx = this.#contextData.get(contextId);
    if (!ctx) {
      return;
    }

    // Only start completion timer when we've received audio AND sent close_context
    if (!ctx.audioReceived || !ctx.contextClosed) {
      return;
    }

    // If already have a completion timer, reset it (more audio came)
    if (ctx.completionTimer) {
      clearTimeout(ctx.completionTimer);
    }

    // Auto-complete after 2 seconds if isFinal doesn't arrive
    const completionTimeout = 2000;
    ctx.completionTimer = setTimeout(() => {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'tts.ts:Connection.completionTimer',
          message: 'Auto-completing stream (no isFinal received)',
          data: { contextId },
          timestamp: Date.now(),
          sessionId: 'debug-session',
          hypothesisId: 'H12-autoComplete',
        }),
      }).catch(() => {});
      // #endregion

      // Auto-complete the stream
      ctx.stream.markDone();
      ctx.waiter.resolve();
      this.#cleanupContext(contextId);
    }, completionTimeout);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#inputQueueResolver?.();

    for (const ctx of this.#contextData.values()) {
      ctx.waiter.reject(new APIStatusError({ message: 'connection closed' }));
      if (ctx.timeoutTimer) {
        clearTimeout(ctx.timeoutTimer);
      }
      if (ctx.completionTimer) {
        clearTimeout(ctx.completionTimer);
      }
    }
    this.#contextData.clear();

    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }

    if (this.#sendTask) {
      await this.#sendTask.catch(() => {});
    }
    if (this.#recvTask) {
      await this.#recvTask.catch(() => {});
    }
  }
}

// ============================================================================
// TTS Class
// ============================================================================

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  #streams = new Set<SynthesizeStream>();
  #currentConnection: Connection | null = null;
  #connectionLock = new Mutex();
  #logger = log();

  label = 'elevenlabs.TTS';

  constructor(opts: TTSOptions = {}) {
    const autoMode = opts.autoMode ?? true;
    const encoding = opts.encoding ?? DEFAULT_ENCODING;
    const sampleRate = sampleRateFromFormat(encoding);

    super(sampleRate, 1, {
      streaming: true,
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
    const language = opts.language ?? opts.languageCode;

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
      preferredAlignment: opts.preferredAlignment ?? 'normalized',
      autoMode,
      pronunciationDictionaryLocators: opts.pronunciationDictionaryLocators,
    };
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
      this.#opts.language = opts.language;
      changed = true;
    }

    if (opts.pronunciationDictionaryLocators !== undefined) {
      this.#opts.pronunciationDictionaryLocators = opts.pronunciationDictionaryLocators;
      changed = true;
    }

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

  stream(): SynthesizeStream {
    const stream = new SynthesizeStream(this, { ...this.#opts });
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

// ============================================================================
// ChunkedStream Class
// ============================================================================

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

    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, 1);

    try {
      const response = await fetch(synthesizeUrl(this.#opts), {
        method: 'POST',
        headers: {
          [AUTHORIZATION_HEADER]: this.#opts.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: this.inputText,
          model_id: this.#opts.model,
          voice_settings: voiceSettings,
        }),
        signal: this.abortSignal,
      });

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

        for (const frame of bstream.write(value.buffer)) {
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

// ============================================================================
// SynthesizeStream Class
// ============================================================================

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

  constructor(tts: TTS, opts: ResolvedTTSOptions) {
    super(tts);
    this.#tts = tts;
    this.#opts = opts;
    this.#contextId = shortuuid();
    this.#sentTokenizerStream = this.#opts.wordTokenizer.stream();
  }

  get contextId(): string {
    return this.#contextId;
  }

  pushAudio(data: Buffer): void {
    this.#audioQueue.push(data);
  }

  pushTimedTranscript(timedWords: TimedString[]): void {
    this.#timedTranscriptQueue.push(...timedWords);
  }

  markDone(): void {
    this.#streamDone = true;
  }

  protected async run(): Promise<void> {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'tts.ts:SynthesizeStream.run',
        message: 'Starting SynthesizeStream',
        data: {
          contextId: this.#contextId,
          sampleRate: this.#opts.sampleRate,
          encoding: this.#opts.encoding,
        },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'H6-encoding',
      }),
    }).catch(() => {});
    // #endregion

    const requestId = this.#contextId;
    const segmentId = this.#contextId;
    const bstream = new AudioByteStream(this.#opts.sampleRate, 1);

    let connection: Connection;
    try {
      connection = await this.#tts.currentConnection();
    } catch (e) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'tts.ts:SynthesizeStream.run',
          message: 'Failed to get connection',
          data: { error: String(e) },
          timestamp: Date.now(),
          sessionId: 'debug-session',
          hypothesisId: 'H1',
        }),
      }).catch(() => {});
      // #endregion
      throw new APIConnectionError({ message: 'could not connect to ElevenLabs' });
    }

    let waiterReject: ((reason: Error) => void) | undefined;
    const waiterPromise = new Promise<void>((resolve, reject) => {
      waiterReject = reject;
      connection.registerStream(this, { resolve, reject });
    });

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
      // Note: close_context tells ElevenLabs we're done with this context
      connection.closeContext(this.#contextId);
    };

    const audioProcessTask = async () => {
      let lastFrame: AudioFrame | undefined;

      while (!this.abortController.signal.aborted) {
        // Process audio queue
        while (this.#audioQueue.length > 0) {
          const audioData = this.#audioQueue.shift()!;
          for (const frame of bstream.write(audioData.buffer)) {
            if (lastFrame) {
              this.queue.put({ requestId, segmentId, frame: lastFrame, final: false });
            }
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

      // Flush remaining
      for (const frame of bstream.flush()) {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final: false });
        }
        lastFrame = frame;
      }

      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final: true });
      }
    };

    try {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'tts.ts:SynthesizeStream.run',
          message: 'Starting Promise.all tasks',
          data: { contextId: this.#contextId },
          timestamp: Date.now(),
          sessionId: 'debug-session',
          hypothesisId: 'H5',
        }),
      }).catch(() => {});
      // #endregion
      await Promise.all([inputTask(), sentenceStreamTask(), audioProcessTask(), waiterPromise]);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'tts.ts:SynthesizeStream.run',
          message: 'Promise.all completed successfully',
          data: { contextId: this.#contextId },
          timestamp: Date.now(),
          sessionId: 'debug-session',
          hypothesisId: 'H5',
        }),
      }).catch(() => {});
      // #endregion
    } catch (e) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/35f1fac8-cdb7-45b3-9fb7-e8fc42ce7342', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'tts.ts:SynthesizeStream.run',
          message: 'Promise.all error',
          data: {
            contextId: this.#contextId,
            error: String(e),
            aborted: this.abortController.signal.aborted,
          },
          timestamp: Date.now(),
          sessionId: 'debug-session',
          hypothesisId: 'H5',
        }),
      }).catch(() => {});
      // #endregion

      // If aborted, this is a normal termination - don't throw
      if (this.abortController.signal.aborted) {
        return;
      }

      if (e instanceof APITimeoutError) {
        throw e;
      }
      if (e instanceof APIStatusError) {
        throw e;
      }
      throw new APIStatusError({ message: 'Could not synthesize' });
    } finally {
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
