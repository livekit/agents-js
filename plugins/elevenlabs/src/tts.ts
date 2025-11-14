// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AsyncIterableQueue,
  AudioByteStream,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import type { TTSEncoding, TTSModels } from './models.js';

const DEFAULT_INACTIVITY_TIMEOUT = 300;
const AUTHORIZATION_HEADER = 'xi-api-key';

type Voice = {
  id: string;
  name: string;
  category: string;
  settings?: VoiceSettings;
};

type VoiceSettings = {
  stability: number; // 0..1
  similarity_boost: number; // 0..1
  style?: number; // 0..1
  use_speaker_boost: boolean;
};

const DEFAULT_VOICE: Voice = {
  id: 'bIHbv24MWmeRgasZH58o',
  name: 'Bella',
  category: 'premade',
  settings: {
    stability: 0.71,
    similarity_boost: 0.5,
    style: 0.0,
    use_speaker_boost: true,
  },
};

const API_BASE_URL_V1 = 'https://api.elevenlabs.io/v1/';

interface TimedWord {
  text: string;
  startTime: number;
  endTime: number;
}

export interface TTSOptions {
  apiKey?: string;
  voice: Voice;
  modelID: TTSModels | string;
  languageCode?: string;
  baseURL: string;
  encoding: TTSEncoding;
  streamingLatency?: number;
  wordTokenizer: tokenize.WordTokenizer | tokenize.SentenceTokenizer;
  chunkLengthSchedule?: number[];
  enableSsmlParsing: boolean;
  inactivityTimeout: number;
  syncAlignment: boolean;
  preferredAlignment: 'normalized' | 'original';
  autoMode?: boolean;
}

const defaultTTSOptionsBase = {
  apiKey: process.env.ELEVEN_API_KEY,
  voice: DEFAULT_VOICE,
  modelID: 'eleven_turbo_v2_5',
  baseURL: API_BASE_URL_V1,
  encoding: 'pcm_22050' as TTSEncoding,
  enableSsmlParsing: false,
  inactivityTimeout: DEFAULT_INACTIVITY_TIMEOUT,
  syncAlignment: true,
  preferredAlignment: 'normalized' as const,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert character-level timing to word-level timing
 * Returns timed words and the remaining text buffer
 */
function toTimedWords(
  text: string,
  startTimesMs: number[],
  durationsMs: number[],
  flush: boolean = false,
): [TimedWord[], string] {
  if (!text || startTimesMs.length === 0 || durationsMs.length === 0) {
    return [[], ''];
  }

  const { splitWords } = tokenize.basic;

  // Calculate timestamps (N+1)
  const lastStartTime = startTimesMs[startTimesMs.length - 1];
  const lastDuration = durationsMs[durationsMs.length - 1];
  if (lastStartTime === undefined || lastDuration === undefined) {
    return [[], text];
  }
  const timestamps = [...startTimesMs, lastStartTime + lastDuration];

  // Split text into words
  const words = splitWords(text, false);
  const timedWords: TimedWord[] = [];

  if (words.length === 0) {
    return [[], text];
  }

  const startIndices = words.map((w) => w[1]);
  let end = 0;

  // We don't know if the last word is complete, always leave it as remaining
  for (let i = 0; i < startIndices.length - 1; i++) {
    const start = startIndices[i];
    const nextStart = startIndices[i + 1];
    if (start === undefined || nextStart === undefined) continue;
    end = nextStart;
    const startT = timestamps[start];
    const endT = timestamps[end];
    if (startT === undefined || endT === undefined) continue;
    timedWords.push({
      text: text.substring(start, end),
      startTime: startT / 1000,
      endTime: endT / 1000,
    });
  }

  if (flush && startIndices.length > 0) {
    const start = startIndices[startIndices.length - 1];
    if (start !== undefined) {
      end = text.length;
      const startT = timestamps[start];
      const endT = timestamps[timestamps.length - 1];
      if (startT !== undefined && endT !== undefined) {
        timedWords.push({
          text: text.substring(start, end),
          startTime: startT / 1000,
          endTime: endT / 1000,
        });
      }
    }
  } else if (startIndices.length > 0) {
    const lastStart = startIndices[startIndices.length - 1];
    if (lastStart !== undefined) {
      end = lastStart;
    }
  }

  return [timedWords, text.substring(end)];
}

// ============================================================================
// WebSocket Connection Manager - Manages persistent connection with multi-stream support
// ============================================================================

interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface StreamContext {
  contextId: string;
  audioQueue: AsyncIterableQueue<Int8Array>;
  transcriptQueue: AsyncIterableQueue<TimedWord[]>;
  eos: DeferredPromise<void>;
  timeoutTimer: NodeJS.Timeout | null;
  timeoutSeconds: number;
  textBuffer: string;
  startTimesMs: number[];
  durationsMs: number[];
}

interface SynthesizeContent {
  type: 'synthesize';
  contextId: string;
  text: string;
  flush: boolean;
}

interface CloseContext {
  type: 'close';
  contextId: string;
}

type QueueMessage = SynthesizeContent | CloseContext;

/**
 * Manages a single persistent WebSocket connection for multi-stream TTS.
 * Allows multiple synthesize requests to share one connection via context IDs.
 */
class WebSocketManager {
  private ws: WebSocket | null = null;
  private opts: TTSOptions;
  private logger = log();
  private inputQueue = new AsyncIterableQueue<QueueMessage>();
  private contextData = new Map<string, StreamContext>();
  private activeContexts = new Set<string>();
  private sendTask: Promise<void> | null = null;
  private recvTask: Promise<void> | null = null;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private closed = false;
  private isCurrent = true;

  constructor(opts: TTSOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.ws || this.closed) {
      return;
    }

    const url = this.buildMultiStreamUrl();
    const headers = {
      [AUTHORIZATION_HEADER]: this.opts.apiKey!,
    };

    this.ws = new WebSocket(url, { headers });

    // Wait for connection to open
    await new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not initialized'));
        return;
      }
      this.ws.once('open', resolve);
      this.ws.once('error', (error) => reject(error));
      this.ws.once('close', (code) => reject(`WebSocket returned ${code}`));
    });

    // Start keepalive ping
    this.keepaliveInterval = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      } catch {
        if (this.keepaliveInterval) {
          clearInterval(this.keepaliveInterval);
          this.keepaliveInterval = null;
        }
      }
    }, 5000);

    // Start send and recv loops
    this.sendTask = this.sendLoop();
    this.recvTask = this.recvLoop();
  }

  registerContext(contextId: string, timeoutSeconds: number = 30): void {
    if (!this.contextData.has(contextId)) {
      const eos: DeferredPromise<void> = {} as DeferredPromise<void>;
      eos.promise = new Promise<void>((resolve, reject) => {
        eos.resolve = resolve;
        eos.reject = reject;
      });

      this.contextData.set(contextId, {
        contextId,
        audioQueue: new AsyncIterableQueue<Int8Array>(),
        transcriptQueue: new AsyncIterableQueue<TimedWord[]>(),
        eos: eos,
        timeoutTimer: null,
        timeoutSeconds,
        textBuffer: '',
        startTimesMs: [],
        durationsMs: [],
      });
    }
  }

  sendContent(contextId: string, text: string, flush: boolean = false): void {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      throw new Error('WebSocket connection is closed');
    }

    this.inputQueue.put({
      type: 'synthesize',
      contextId,
      text,
      flush,
    });
  }

  closeContext(contextId: string): void {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      throw new Error('WebSocket connection is closed');
    }

    this.inputQueue.put({
      type: 'close',
      contextId,
    });
  }

  getContextAudioQueue(contextId: string): AsyncIterableQueue<Int8Array> | null {
    return this.contextData.get(contextId)?.audioQueue ?? null;
  }

  getContextTranscriptQueue(contextId: string): AsyncIterableQueue<TimedWord[]> | null {
    return this.contextData.get(contextId)?.transcriptQueue ?? null;
  }

  getContextEOSPromise(contextId: string): Promise<void> | null {
    return this.contextData.get(contextId)?.eos.promise ?? null;
  }

  markNonCurrent(): void {
    this.isCurrent = false;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private cleanupContext(contextId: string): void {
    const ctx = this.contextData.get(contextId);
    if (ctx) {
      if (ctx.timeoutTimer) {
        clearTimeout(ctx.timeoutTimer);
      }
      ctx.audioQueue.close();
      ctx.transcriptQueue.close();
    }
    this.contextData.delete(contextId);
    this.activeContexts.delete(contextId);
  }

  private startTimeoutTimer(contextId: string): void {
    const ctx = this.contextData.get(contextId);
    if (!ctx || ctx.timeoutTimer) {
      return;
    }

    ctx.timeoutTimer = setTimeout(() => {
      this.logger.error(
        { contextId },
        `TTS: Context timed out after ${ctx.timeoutSeconds} seconds`,
      );
      ctx.eos.reject(new Error(`TTS timed out after ${ctx.timeoutSeconds} seconds`));
      this.cleanupContext(contextId);
    }, ctx.timeoutSeconds * 1000);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.inputQueue.close();

    // Clear all timeout timers
    for (const ctx of this.contextData.values()) {
      if (ctx.timeoutTimer) {
        clearTimeout(ctx.timeoutTimer);
      }
    }

    this.contextData.clear();
    this.activeContexts.clear();

    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    if (this.sendTask) {
      try {
        await this.sendTask;
      } catch {
        // Expected when queue closes
      }
    }

    if (this.recvTask) {
      try {
        await this.recvTask;
      } catch {
        // Expected when connection closes
      }
    }
  }

  private buildMultiStreamUrl(): string {
    const baseURL = this.opts.baseURL
      .replace('https://', 'wss://')
      .replace('http://', 'ws://')
      .replace(/\/$/, '');

    const voiceId = this.opts.voice.id;
    let urlStr = `${baseURL}/text-to-speech/${voiceId}/multi-stream-input?`;

    const params: string[] = [];
    params.push(`model_id=${this.opts.modelID}`);
    params.push(`output_format=${this.opts.encoding}`);
    params.push(`enable_ssml_parsing=${this.opts.enableSsmlParsing}`);
    params.push(`sync_alignment=${this.opts.syncAlignment}`);
    params.push(`inactivity_timeout=${this.opts.inactivityTimeout}`);

    if (this.opts.streamingLatency !== undefined) {
      params.push(`optimize_streaming_latency=${this.opts.streamingLatency}`);
    }

    if (this.opts.autoMode !== undefined) {
      params.push(`auto_mode=${this.opts.autoMode}`);
    }

    if (this.opts.languageCode) {
      params.push(`language_code=${this.opts.languageCode}`);
    }

    urlStr += params.join('&');
    return urlStr;
  }

  private async sendLoop(): Promise<void> {
    try {
      for await (const msg of this.inputQueue) {
        if (!this.ws || this.ws.readyState !== 1) {
          break;
        }

        if (msg.type === 'synthesize') {
          const isNewContext = !this.activeContexts.has(msg.contextId);

          // If not current and new context, ignore (connection is draining)
          if (!this.isCurrent && isNewContext) {
            continue;
          }

          if (isNewContext) {
            const voiceSettings = this.opts.voice.settings || {};
            const initPkt = {
              text: ' ',
              voice_settings: voiceSettings,
              context_id: msg.contextId,
              ...(this.opts.chunkLengthSchedule && {
                generation_config: {
                  chunk_length_schedule: this.opts.chunkLengthSchedule,
                },
              }),
            };

            this.ws.send(JSON.stringify(initPkt));
            this.activeContexts.add(msg.contextId);
          }

          const pkt: { text: string; context_id: string; flush?: boolean } = {
            text: msg.text,
            context_id: msg.contextId,
          };
          if (msg.flush) {
            pkt.flush = true;
          }

          // Start timeout timer for this context
          this.startTimeoutTimer(msg.contextId);

          this.ws.send(JSON.stringify(pkt));
        } else if (msg.type === 'close') {
          if (this.activeContexts.has(msg.contextId)) {
            const closePkt = {
              context_id: msg.contextId,
              close_context: true,
            };
            this.ws.send(JSON.stringify(closePkt));
            this.activeContexts.delete(msg.contextId);
          }
        } else {
          this.logger.error(`TTS: Unknown msg type: ${msg}`);
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'TTS: Error in send loop');
    } finally {
      if (!this.closed) {
        await this.close();
      }
    }
  }

  private async recvLoop(): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        if (!this.ws) {
          reject(new Error('WebSocket not available'));
          return;
        }

        this.ws.on('message', (msg: RawData) => {
          try {
            const data = JSON.parse(msg.toString()) as Record<string, unknown>;
            const contextId = (data.contextId || data.context_id) as string | undefined;

            if (!contextId || !this.contextData.has(contextId)) {
              return;
            }

            const context = this.contextData.get(contextId)!;

            this.logger.debug({ data }, 'TTS: Incoming message');

            if (data.error) {
              this.logger.error({ contextId, error: data.error }, 'TTS: ElevenLabs error');
              this.cleanupContext(contextId);
              return;
            }

            // Process alignment data if available
            const alignment =
              this.opts.preferredAlignment === 'normalized'
                ? data.normalizedAlignment
                : data.alignment;

            if (alignment && typeof alignment === 'object') {
              const alignmentObj = alignment as {
                chars?: string[];
                charStartTimesMs?: number[];
                charsStartTimesMs?: number[];
                charDurationsMs?: number[];
                charsDurationsMs?: number[];
              };

              const chars = alignmentObj.chars;
              const starts = alignmentObj.charStartTimesMs || alignmentObj.charsStartTimesMs;
              const durs = alignmentObj.charDurationsMs || alignmentObj.charsDurationsMs;

              if (
                chars &&
                starts &&
                durs &&
                chars.length === durs.length &&
                starts.length === durs.length
              ) {
                context.textBuffer += chars.join('');

                // Handle multi-character items in chars array
                for (let i = 0; i < chars.length; i++) {
                  const char = chars[i];
                  const start = starts[i];
                  const dur = durs[i];

                  if (char === undefined || start === undefined || dur === undefined) {
                    continue;
                  }

                  if (char.length > 1) {
                    // Add padding for multi-character items
                    for (let j = 0; j < char.length - 1; j++) {
                      context.startTimesMs.push(start);
                      context.durationsMs.push(0);
                    }
                  }
                  context.startTimesMs.push(start);
                  context.durationsMs.push(dur);
                }

                // Convert to timed words
                const [timedWords, remainingText] = toTimedWords(
                  context.textBuffer,
                  context.startTimesMs,
                  context.durationsMs,
                );

                if (timedWords.length > 0) {
                  context.transcriptQueue.put(timedWords);
                }

                // Update buffers with remaining text
                context.textBuffer = remainingText;
                context.startTimesMs = context.startTimesMs.slice(-remainingText.length);
                context.durationsMs = context.durationsMs.slice(-remainingText.length);
              }
            }

            if (data.audio) {
              const audioBuffer = Buffer.from(data.audio as string, 'base64');
              const audioArray = new Int8Array(audioBuffer);
              context.audioQueue.put(audioArray);

              // Cancel timeout when audio is received
              if (context.timeoutTimer) {
                clearTimeout(context.timeoutTimer);
                context.timeoutTimer = null;
              }
            }

            if (data.isFinal) {
              // Flush remaining text buffer
              if (context.textBuffer.length > 0) {
                const [timedWords] = toTimedWords(
                  context.textBuffer,
                  context.startTimesMs,
                  context.durationsMs,
                  true,
                );
                if (timedWords.length > 0) {
                  context.transcriptQueue.put(timedWords);
                }
              }

              context.eos.resolve();
              this.cleanupContext(contextId);

              if (!this.isCurrent && this.activeContexts.size === 0) {
                this.logger.debug('TTS: No active contexts, shutting down');
                resolve();
              }
            }

            if (this.closed) {
              resolve();
            }
          } catch (parseError) {
            this.logger.warn({ parseError }, 'TTS: Failed to parse message');
          }
        });

        this.ws.once('close', (code, reason) => {
          if (!this.closed) {
            this.logger.error(`TTS: WebSocket closed unexpectedly with code ${code}: ${reason}`);
            reject(new Error('WebSocket closed'));
          } else {
            resolve();
          }
        });

        this.ws.once('error', (error) => {
          this.logger.error({ error }, 'TTS: WebSocket error');
          reject(error);
        });
      });
    } catch (error) {
      this.logger.error({ error }, 'TTS: Recv loop error');
      for (const context of this.contextData.values()) {
        context.eos.reject(error);
      }
    } finally {
      if (!this.closed) {
        await this.close();
      }
    }
  }
}

// ============================================================================
// TTS Implementation
// ============================================================================

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #connection: WebSocketManager | null = null;
  #connectionLock: Promise<void> | null = null;
  label = 'elevenlabs.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(sampleRateFromFormat(opts.encoding || defaultTTSOptionsBase.encoding), 1, {
      streaming: true,
    });

    // Set autoMode to true by default if not provided is Python behavior,
    // but to make it non-breaking, we keep false as default in typescript
    const autoMode = opts.autoMode !== undefined ? opts.autoMode : false;

    // Set default tokenizer based on autoMode if not provided
    let wordTokenizer = opts.wordTokenizer;
    if (!wordTokenizer) {
      wordTokenizer = autoMode
        ? new tokenize.basic.SentenceTokenizer()
        : new tokenize.basic.WordTokenizer(false);
    } else if (autoMode && !(wordTokenizer instanceof tokenize.SentenceTokenizer)) {
      // Warn if autoMode is enabled but a WordTokenizer was provided
      log().warn(
        'autoMode is enabled, it expects full sentences or phrases. ' +
          'Please provide a SentenceTokenizer instead of a WordTokenizer.',
      );
    }

    this.#opts = {
      ...defaultTTSOptionsBase,
      ...opts,
      autoMode,
      wordTokenizer,
    };

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'ElevenLabs API key is required, whether as an argument or as $ELEVEN_API_KEY',
      );
    }
  }

  async listVoices(): Promise<Voice[]> {
    return fetch(this.#opts.baseURL + '/voices', {
      headers: {
        [AUTHORIZATION_HEADER]: this.#opts.apiKey!,
      },
    })
      .then((data) => data.json())
      .then((data) => {
        const voices: Voice[] = [];
        for (const voice of (
          data as { voices: { voice_id: string; name: string; category: string }[] }
        ).voices) {
          voices.push({
            id: voice.voice_id,
            name: voice.name,
            category: voice.category,
            settings: undefined,
          });
        }
        return voices;
      });
  }

  async getCurrentConnection(): Promise<WebSocketManager> {
    // Wait for any ongoing connection attempt
    if (this.#connectionLock) {
      await this.#connectionLock;
      if (this.#connection && !this.#connection.isClosed) {
        return this.#connection;
      }
    }

    // Create new lock for this connection attempt
    const newConnectionLock = (async () => {
      // Mark old connection as non-current if it exists
      if (this.#connection && !this.#connection.isClosed) {
        this.#connection.markNonCurrent();
      }

      // Create and connect new manager
      const manager = new WebSocketManager(this.#opts);
      await manager.connect();
      this.#connection = manager;
    })();

    this.#connectionLock = newConnectionLock;
    try {
      await newConnectionLock;
    } finally {
      this.#connectionLock = null;
    }

    return this.#connection!;
  }

  synthesize(): tts.ChunkedStream {
    throw new Error('Chunked responses are not supported on ElevenLabs TTS');
  }

  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts);
  }

  async aclose(): Promise<void> {
    if (this.#connection) {
      await this.#connection.close();
      this.#connection = null;
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  #tts: TTS;
  #contextId: string;
  #connection: WebSocketManager | null = null;
  label = 'elevenlabs.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#tts = tts;
    this.#opts = opts;
    this.#contextId = shortuuid();
  }

  protected async run() {
    try {
      // Get persistent connection
      this.#connection = await this.#tts.getCurrentConnection();
      this.#connection.registerContext(this.#contextId);

      const segments = new AsyncIterableQueue<tokenize.WordStream | tokenize.SentenceStream>();

      const tokenizeInput = async () => {
        let stream: tokenize.WordStream | tokenize.SentenceStream | null = null;
        for await (const text of this.input) {
          if (this.abortController.signal.aborted) {
            break;
          }
          if (text === SynthesizeStream.FLUSH_SENTINEL) {
            stream?.endInput();
            stream = null;
          } else {
            if (!stream) {
              stream = this.#opts.wordTokenizer.stream();
              segments.put(stream);
            }
            stream.pushText(text);
          }
        }
        segments.close();
      };

      const runStream = async () => {
        for await (const stream of segments) {
          if (this.abortController.signal.aborted) {
            break;
          }
          await this.runSynthesis(stream);
          this.queue.put(SynthesizeStream.END_OF_STREAM);
        }
      };

      await Promise.all([tokenizeInput(), runStream()]);
    } finally {
      if (this.#connection) {
        try {
          this.#connection.closeContext(this.#contextId);
        } catch {
          // Connection may be closed
        }
      }
    }
  }

  private async runSynthesis(stream: tokenize.WordStream | tokenize.SentenceStream): Promise<void> {
    if (!this.#connection) {
      throw new Error('Connection not established');
    }

    const bstream = new AudioByteStream(sampleRateFromFormat(this.#opts.encoding), 1);

    const sendTask = async () => {
      // Determine if we should flush on each chunk (sentence)
      const flushOnChunk =
        this.#opts.wordTokenizer instanceof tokenize.SentenceTokenizer &&
        this.#opts.autoMode !== undefined &&
        this.#opts.autoMode;

      let xmlContent: string[] = [];
      for await (const data of stream) {
        if (this.abortController.signal.aborted) {
          break;
        }
        let text = data.token;

        if ((this.#opts.enableSsmlParsing && text.startsWith('<phoneme')) || xmlContent.length) {
          xmlContent.push(text);
          if (text.indexOf('</phoneme>') !== -1) {
            text = xmlContent.join(' ');
            xmlContent = [];
          } else {
            continue;
          }
        }

        this.#connection!.sendContent(this.#contextId, text + ' ', flushOnChunk);
      }

      if (xmlContent.length) {
        this.#logger.warn('TTS: Stream ended with incomplete XML content');
      }

      // Signal end of stream with flush
      this.#connection!.sendContent(this.#contextId, '', true);
      this.#connection!.closeContext(this.#contextId);
    };

    let lastFrame: AudioFrame | undefined;
    let lastDeltaText: string | undefined;
    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({
          requestId: this.#contextId,
          segmentId,
          frame: lastFrame,
          deltaText: lastDeltaText,
          final,
        });
        lastFrame = undefined;
        lastDeltaText = undefined;
      }
    };

    const listenTask = async () => {
      const audioQueue = this.#connection!.getContextAudioQueue(this.#contextId);
      if (!audioQueue) {
        return;
      }

      const transcriptQueue = this.#connection!.getContextTranscriptQueue(this.#contextId);
      if (!transcriptQueue) {
        return;
      }

      const eosPromise = this.#connection!.getContextEOSPromise(this.#contextId);
      if (!eosPromise) {
        return;
      }

      // Process audio and transcript as they arrive, until EOS
      const processAudio = async () => {
        for await (const buffer of audioQueue) {
          for (const frame of bstream.write(buffer)) {
            sendLastFrame(this.#contextId, false);
            lastFrame = frame;
          }
        }
      };

      const processTranscript = async () => {
        for await (const timedWords of transcriptQueue) {
          // Concatenate timed words into deltaText
          // In a more sophisticated implementation, we could track timing
          // and associate words with specific frames
          const deltaText = timedWords.map((w) => w.text).join('');
          if (deltaText) {
            lastDeltaText = deltaText;
          }
        }
      };

      // Start processing immediately, but catch errors of promises immediately
      await new Promise<void>(async (resolve, reject) => {
        const audioTask = processAudio().catch(reject);
        const transcriptTask = processTranscript().catch(reject);

        try {
          // Wait for EOS to be signaled
          await eosPromise;

          // Ensure both queues are fully drained after EOS
          await Promise.all([audioTask, transcriptTask]);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      // Flush remaining frames
      for (const frame of bstream.flush()) {
        sendLastFrame(this.#contextId, false);
        lastFrame = frame;
      }

      sendLastFrame(this.#contextId, true);
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    };

    await Promise.all([sendTask(), listenTask()]);
  }
}

const sampleRateFromFormat = (encoding: TTSEncoding): number => {
  return Number(encoding.split('_')[1]);
};
