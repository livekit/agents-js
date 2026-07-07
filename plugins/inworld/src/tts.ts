// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  type TimedString,
  asError,
  createTimedString,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { type RawData, WebSocket } from 'ws';

const USER_AGENT = 'livekit-agents-js';

const DEFAULT_BIT_RATE = 64000;
const DEFAULT_ENCODING = 'PCM';
const DEFAULT_MODEL = 'inworld-tts-2';
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_URL = 'https://api.inworld.ai/';
const DEFAULT_WS_URL = 'wss://api.inworld.ai/';
const DEFAULT_VOICE = 'Jason';
const DEFAULT_TEMPERATURE = 1.1;
const DEFAULT_TIMESTAMP_TRANSPORT_STRATEGY = 'ASYNC';
const DEFAULT_SPEAKING_RATE = 1.0;
const DEFAULT_BUFFER_CHAR_THRESHOLD = 100;
const DEFAULT_MAX_BUFFER_DELAY_MS = 3000;
const NUM_CHANNELS = 1;

export type TTSModels = 'inworld-tts-2' | 'inworld-tts-1.5-max';
export type Encoding = 'PCM' | 'LINEAR16';
export type TimestampType = 'TIMESTAMP_TYPE_UNSPECIFIED' | 'WORD' | 'CHARACTER';
export type TextNormalization = 'APPLY_TEXT_NORMALIZATION_UNSPECIFIED' | 'ON' | 'OFF';
export type TimestampTransportStrategy =
  | 'TIMESTAMP_TRANSPORT_STRATEGY_UNSPECIFIED'
  | 'SYNC'
  | 'ASYNC';
export type DeliveryMode = 'DELIVERY_MODE_UNSPECIFIED' | 'STABLE' | 'BALANCED' | 'CREATIVE';

export interface TTSOptions {
  apiKey?: string;
  voice: string;
  model: TTSModels | string;
  encoding: Encoding;
  bitRate: number;
  sampleRate: number;
  speakingRate: number;
  temperature: number;
  /** BCP-47 language tag specifying the language the voice should speak in. */
  language?: string;
  timestampType?: TimestampType;
  textNormalization?: TextNormalization;
  /** Controls output variation on inworld-tts-2 only. */
  deliveryMode?: DeliveryMode;
  timestampTransportStrategy?: TimestampTransportStrategy;
  bufferCharThreshold: number;
  maxBufferDelayMs: number;
  baseURL: string;
  wsURL: string;
  tokenizer?: tokenize.SentenceTokenizer;
}

// API request/response types
interface AudioConfig {
  audioEncoding: Encoding;
  sampleRateHertz: number;
  bitrate: number;
  speakingRate: number;
  temperature?: number;
}

interface SynthesizeRequest {
  text: string;
  voiceId: string;
  modelId: string;
  audioConfig: AudioConfig;
  temperature: number;
  language?: string;
  timestampType?: TimestampType;
  applyTextNormalization?: TextNormalization;
  deliveryMode?: DeliveryMode;
  timestampTransportStrategy?: TimestampTransportStrategy;
}

interface CreateContextConfig {
  voiceId: string;
  modelId: string;
  audioConfig: AudioConfig;
  temperature: number;
  language?: string;
  bufferCharThreshold: number;
  maxBufferDelayMs: number;
  timestampType?: TimestampType;
  applyTextNormalization?: TextNormalization;
  deliveryMode?: DeliveryMode;
  timestampTransportStrategy?: TimestampTransportStrategy;
  autoMode?: boolean;
}

interface WordAlignment {
  words: string[];
  wordStartTimeSeconds: number[];
  wordEndTimeSeconds: number[];
}

interface CharacterAlignment {
  characters: string[];
  characterStartTimeSeconds: number[];
  characterEndTimeSeconds: number[];
}

interface TimestampInfo {
  wordAlignment?: WordAlignment;
  characterAlignment?: CharacterAlignment;
}

interface AudioChunk {
  audioContent?: string;
  timestampInfo?: TimestampInfo;
}

interface InworldResult {
  contextId?: string;
  contextCreated?: boolean;
  contextClosed?: boolean;
  flushCompleted?: boolean;
  audioChunk?: AudioChunk;
  audioContent?: string;
  status?: { code: number; message: string };
}

interface InworldMessage {
  result?: InworldResult;
  contextId?: string;
  error?: { message: string };
}

export interface Voice {
  voiceId: string;
  displayName: string;
  description: string;
  languages: string[];
  tags: string[];
}

interface ListVoicesResponse {
  voices: Voice[];
}

const defaultTTSOptionsBase: Omit<TTSOptions, 'tokenizer'> = {
  apiKey: process.env.INWORLD_API_KEY,
  voice: DEFAULT_VOICE,
  model: DEFAULT_MODEL,
  encoding: DEFAULT_ENCODING as Encoding,
  bitRate: DEFAULT_BIT_RATE,
  sampleRate: DEFAULT_SAMPLE_RATE,
  speakingRate: DEFAULT_SPEAKING_RATE,
  temperature: DEFAULT_TEMPERATURE,
  timestampTransportStrategy: DEFAULT_TIMESTAMP_TRANSPORT_STRATEGY as TimestampTransportStrategy,
  bufferCharThreshold: DEFAULT_BUFFER_CHAR_THRESHOLD,
  maxBufferDelayMs: DEFAULT_MAX_BUFFER_DELAY_MS,
  baseURL: DEFAULT_URL,
  wsURL: DEFAULT_WS_URL,
};

const CONNECT_TIMEOUT_MS = 10_000; // WebSocket handshake timeout

// Transient gRPC-style status codes worth retrying; everything else is treated as
// a permanent request rejection. 4 = DEADLINE_EXCEEDED, 8 = RESOURCE_EXHAUSTED
// (rate limit), 14 = UNAVAILABLE.
const RETRYABLE_STATUS_CODES = new Set([4, 8, 14]);

class WSConnectionPool {
  #ws?: WebSocket;
  #url: string;
  #auth: string;
  #connecting?: Promise<WebSocket>;
  #listeners: Map<string, (msg: InworldMessage) => void> = new Map();
  #logger = log();

  constructor(url: string, auth: string) {
    this.#url = url;
    this.#auth = auth;
  }

  async getConnection(): Promise<WebSocket> {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      return this.#ws;
    }

    if (this.#connecting) {
      return this.#connecting;
    }

    // A single connection attempt. Retries are delegated to the framework's
    // SynthesizeStream retry loop (off the synthesis hot path) by surfacing a
    // retryable APIConnectionError/APITimeoutError on failure.
    this.#connecting = this.#attemptConnection();
    return this.#connecting;
  }

  #attemptConnection(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const wsUrl = new URL('tts/v1/voice:streamBidirectional', this.#url);
      if (wsUrl.protocol === 'https:') wsUrl.protocol = 'wss:';
      else if (wsUrl.protocol === 'http:') wsUrl.protocol = 'ws:';

      const requestId = randomUUID();
      const ws = new WebSocket(wsUrl.toString(), {
        headers: {
          Authorization: this.#auth,
          'X-User-Agent': USER_AGENT,
          'X-Request-Id': requestId,
        },
        // Backstop slightly above our own timer so the explicit timer below is
        // the one that fires, yielding a semantically correct APITimeoutError.
        handshakeTimeout: CONNECT_TIMEOUT_MS + 1_000,
      });

      // Bound the handshake so a blackholed host fails fast with a retryable
      // timeout rather than an unbounded OS-level hang.
      let settled = false;
      const handshakeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#connecting = undefined;
        ws.terminate();
        reject(
          new APITimeoutError({
            message: `Inworld WebSocket handshake timed out after ${CONNECT_TIMEOUT_MS}ms`,
          }),
        );
      }, CONNECT_TIMEOUT_MS);
      handshakeTimer.unref?.();

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        this.#ws = ws;
        this.#connecting = undefined;
        this.#logger.debug({ requestId }, 'Established Inworld TTS WebSocket connection');
        resolve(ws);
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(handshakeTimer);
          this.#connecting = undefined;
          reject(
            new APIConnectionError({
              message: `Failed to connect to Inworld: ${asError(err).message}`,
            }),
          );
        } else {
          this.#logger.error({ err, requestId }, 'Inworld WebSocket error');
        }
      });

      ws.on('close', () => {
        this.#ws = undefined;
        this.#connecting = undefined;
      });

      ws.on('message', (data: RawData) => {
        try {
          const json = JSON.parse(data.toString()) as InworldMessage;
          const result = json.result;
          if (result) {
            const contextId = result.contextId || json.contextId;
            if (contextId && this.#listeners.has(contextId)) {
              this.#listeners.get(contextId)!(json);
            }
          } else if (json.error) {
            this.#logger.warn({ error: json.error }, 'Inworld received error message');
          }
        } catch (e) {
          this.#logger.warn({ error: e }, 'Failed to parse Inworld WebSocket message');
        }
      });
    });
  }

  registerListener(contextId: string, cb: (msg: InworldMessage) => void) {
    this.#listeners.set(contextId, cb);
  }

  unregisterListener(contextId: string) {
    this.#listeners.delete(contextId);
  }

  close() {
    if (this.#ws) {
      this.#ws.close();
      this.#ws = undefined;
    }
  }
}

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #pool: WSConnectionPool;
  #authorization: string;
  label = 'inworld.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const mergedOpts = { ...defaultTTSOptionsBase, ...opts };
    if (!mergedOpts.apiKey) {
      throw new Error('Inworld API key required. Set INWORLD_API_KEY or provide apiKey.');
    }

    super(mergedOpts.sampleRate, NUM_CHANNELS, {
      streaming: true,
      alignedTranscript: !!mergedOpts.timestampType,
    });

    this.#opts = mergedOpts as TTSOptions;
    if (!this.#opts.tokenizer) {
      this.#opts.tokenizer = new tokenize.basic.SentenceTokenizer({ retainFormat: true });
    }
    this.#authorization = `Basic ${mergedOpts.apiKey}`;
    this.#pool = new WSConnectionPool(this.#opts.wsURL, this.#authorization);
  }

  get pool(): WSConnectionPool {
    return this.#pool;
  }

  get authorization(): string {
    return this.#authorization;
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Inworld';
  }

  /** @internal */
  override _markupProviderKey(): string {
    return 'inworld';
  }

  /**
   * List all available voices in the workspace associated with the API key.
   * @param language - Optional ISO 639-1 language code to filter voices (e.g., 'en', 'es', 'fr')
   */
  async listVoices(language?: string): Promise<Voice[]> {
    const url = new URL('tts/v1/voices', this.#opts.baseURL);
    if (language) {
      url.searchParams.set('filter', `language=${language}`);
    }

    const requestId = randomUUID();
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: this.#authorization,
        'X-User-Agent': USER_AGENT,
        'X-Request-Id': requestId,
      },
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(
        `Inworld API error: ${response.status} ${response.statusText}${errorBody.message ? ` - ${errorBody.message}` : ''} (request_id=${requestId})`,
      );
    }

    const data = (await response.json()) as ListVoicesResponse;
    return data.voices;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts, options?.connOptions);
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };
    if (opts.apiKey) {
      this.#authorization = `Basic ${opts.apiKey}`;
      this.#pool.close();
      this.#pool = new WSConnectionPool(this.#opts.wsURL, this.#authorization);
    }
  }

  async close() {
    this.#pool.close();
  }
}

class ChunkedStream extends tts.ChunkedStream {
  #opts: TTSOptions;
  #tts: TTS;
  label = 'inworld.ChunkedStream';

  constructor(
    ttsInstance: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#tts = ttsInstance;
    this.#opts = opts;
  }

  protected async run() {
    const audioConfig: AudioConfig = {
      audioEncoding: this.#opts.encoding,
      bitrate: this.#opts.bitRate,
      sampleRateHertz: this.#opts.sampleRate,
      temperature: this.#opts.temperature,
      speakingRate: this.#opts.speakingRate,
    };

    const bodyParams: SynthesizeRequest = {
      text: this.inputText,
      voiceId: this.#opts.voice,
      modelId: this.#opts.model,
      audioConfig: audioConfig,
      temperature: this.#opts.temperature,
      language: this.#opts.language,
      timestampType: this.#opts.timestampType,
      applyTextNormalization: this.#opts.textNormalization,
      deliveryMode: this.#opts.deliveryMode,
      timestampTransportStrategy: this.#opts.timestampTransportStrategy,
    };

    const url = new URL('tts/v1/voice:stream', this.#opts.baseURL);

    const requestId = randomUUID();
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: this.#tts.authorization,
          'Content-Type': 'application/json',
          'X-User-Agent': USER_AGENT,
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(bodyParams),
        signal: this.abortSignal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return;
      }
      throw e;
    }

    if (!response.ok) {
      throw new Error(
        `Inworld API error: ${response.status} ${response.statusText} (request_id=${requestId})`,
      );
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const segmentId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            if (data.result) {
              if (data.result.audioContent) {
                const audio = Buffer.from(data.result.audioContent, 'base64');

                let pcmData = audio;
                if (audio.length > 44 && audio.subarray(0, 4).toString() === 'RIFF') {
                  // This is a WAV header, skip 44 bytes
                  pcmData = audio.subarray(44);
                }

                for (const frame of bstream.write(
                  pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength),
                )) {
                  this.queue.put({
                    requestId: segmentId,
                    segmentId,
                    frame,
                    final: false,
                  });
                }
              }
            } else if (data.error) {
              throw new Error(data.error.message);
            }
          } catch (e) {
            log().warn({ error: e, line }, 'Failed to parse Inworld chunk');
          }
        }
      }
    }

    // Flush remaining frames
    for (const frame of bstream.flush()) {
      this.queue.put({
        requestId: segmentId,
        segmentId,
        frame,
        final: false,
      });
    }
  }
}

class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #tts: TTS;
  #contextId: string;
  // Cumulative timestamp tracking for monotonic timestamps across generations.
  // When auto_mode is enabled or flush_context() is called, the server resets
  // timestamps to 0 after each generation. We add cumulativeTime to maintain
  // monotonically increasing timestamps within an agent turn.
  #cumulativeTime: number = 0;
  #generationEndTime: number = 0;
  label = 'inworld.SynthesizeStream';

  constructor(ttsInstance: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#tts = ttsInstance;
    this.#opts = opts;
    this.#contextId = shortuuid();
  }

  protected async run() {
    // The framework's retry loop re-invokes run() on the same instance, so reset
    // per-attempt state: use a fresh context id (reusing one risks colliding with
    // the failed attempt's server-side context or being resolved by its stale
    // contextClosed) and zero the cumulative timestamp offsets.
    this.#contextId = shortuuid();
    this.#cumulativeTime = 0;
    this.#generationEndTime = 0;

    const ws = await this.#tts.pool.getConnection();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const tokenizerStream = this.#opts.tokenizer!.stream();

    let resolveProcessing: () => void;
    let rejectProcessing: (err: Error) => void;
    const processing = new Promise<void>((resolve, reject) => {
      resolveProcessing = resolve;
      rejectProcessing = reject;
    });
    // `processing` can be rejected (by onClose below, or a server status error)
    // before it is awaited at the Promise.race() further down: if a send/flush
    // throws first we jump straight to the catch block and skip the race. Attach
    // a no-op handler so that early rejection is never an unhandled rejection
    // (which aborts the process in Node >= 15). The real error still surfaces via
    // the thrown send/flush/close, so retry behavior is unchanged.
    processing.catch(() => {});

    // If the shared socket drops mid-turn, fail the turn fast with a retryable
    // error so the framework restarts it on a fresh connection, instead of
    // waiting out the in-turn timeout below.
    const onClose = () => {
      rejectProcessing(new APIConnectionError({ message: 'Inworld WebSocket closed' }));
    };
    ws.on('close', onClose);

    let lastFrame: AudioFrame | undefined;
    let pendingTimedTranscripts: TimedString[] = [];

    const sendLastFrame = (final: boolean) => {
      if (lastFrame && !this.queue.closed) {
        this.queue.put({
          requestId: this.#contextId,
          segmentId: this.#contextId,
          frame: lastFrame,
          final,
          timedTranscripts:
            pendingTimedTranscripts.length > 0 ? pendingTimedTranscripts : undefined,
        });
        lastFrame = undefined;
        pendingTimedTranscripts = [];
      }
    };

    const handleMessage = (msg: InworldMessage) => {
      const result = msg.result;
      if (!result) return;

      if (result.contextCreated) {
      } else if (result.contextClosed) {
        resolveProcessing();
      } else if (result.flushCompleted) {
        // Signals the end of a generation. Subsequent timestamps from the server
        // will reset offset to 0. Update cumulative time to maintain monotonically
        // increasing timestamps within the agent turn.
        this.#cumulativeTime = this.#generationEndTime;
      } else if (result.audioChunk) {
        if (result.audioChunk.timestampInfo) {
          const tsInfo = result.audioChunk.timestampInfo;
          if (tsInfo.wordAlignment) {
            const words = tsInfo.wordAlignment.words || [];
            const rawStarts = tsInfo.wordAlignment.wordStartTimeSeconds || [];
            const rawEnds = tsInfo.wordAlignment.wordEndTimeSeconds || [];

            // Apply cumulative offset for monotonic timestamps across generations
            const starts = rawStarts.map((t: number) => t + this.#cumulativeTime);
            const ends = rawEnds.map((t: number) => t + this.#cumulativeTime);

            // Track generation end time from last word for cumulative offset
            if (ends.length > 0) {
              this.#generationEndTime = Math.max(this.#generationEndTime, ends[ends.length - 1]!);
            }

            // Create TimedString objects for the framework pipeline
            for (let i = 0; i < words.length; i++) {
              if (words[i] !== undefined && starts[i] !== undefined && ends[i] !== undefined) {
                pendingTimedTranscripts.push(
                  createTimedString({
                    text: words[i]!,
                    startTime: starts[i],
                    endTime: ends[i],
                  }),
                );
              }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.#tts as any).emit('alignment', {
              requestId: this.#contextId,
              segmentId: this.#contextId,
              wordAlignment: { words, starts, ends },
            });
          }

          if (tsInfo.characterAlignment) {
            const chars = tsInfo.characterAlignment.characters || [];
            const rawStarts = tsInfo.characterAlignment.characterStartTimeSeconds || [];
            const rawEnds = tsInfo.characterAlignment.characterEndTimeSeconds || [];

            // Apply cumulative offset for monotonic timestamps across generations
            const starts = rawStarts.map((t: number) => t + this.#cumulativeTime);
            const ends = rawEnds.map((t: number) => t + this.#cumulativeTime);

            // Track generation end time from last character for cumulative offset
            if (ends.length > 0) {
              this.#generationEndTime = Math.max(this.#generationEndTime, ends[ends.length - 1]!);
            }

            // Create TimedString objects for character-level alignment
            for (let i = 0; i < chars.length; i++) {
              if (chars[i] !== undefined && starts[i] !== undefined && ends[i] !== undefined) {
                pendingTimedTranscripts.push(
                  createTimedString({
                    text: chars[i]!,
                    startTime: starts[i],
                    endTime: ends[i],
                  }),
                );
              }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.#tts as any).emit('alignment', {
              requestId: this.#contextId,
              segmentId: this.#contextId,
              characterAlignment: { chars, starts, ends },
            });
          }
        }

        if (result.audioChunk.audioContent) {
          const b64Content = result.audioChunk.audioContent || result.audioContent;
          if (b64Content) {
            const audio = Buffer.from(b64Content, 'base64');
            let pcmData = audio;
            if (audio.length > 44 && audio.subarray(0, 4).toString() === 'RIFF') {
              // This is a WAV header, skip 44 bytes
              pcmData = audio.subarray(44);
            }
            for (const frame of bstream.write(
              pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength),
            )) {
              sendLastFrame(false);
              lastFrame = frame;
            }
          }
        }
      } else if (result.status && result.status.code !== 0) {
        // status.code is a gRPC-style code (0-16), not an HTTP status, so
        // APIStatusError's 4xx heuristic can't classify it. Retry only transient
        // codes (rate limit / unavailable / deadline); permanent request
        // rejections (bad voice/params, auth) fail fast instead of retrying.
        rejectProcessing(
          new APIStatusError({
            message: `Inworld stream error: ${result.status.message}`,
            options: {
              statusCode: result.status.code,
              retryable: RETRYABLE_STATUS_CODES.has(result.status.code),
            },
          }),
        );
      }
    };

    this.#tts.pool.registerListener(this.#contextId, handleMessage);

    const sendLoop = async () => {
      for await (const ev of tokenizerStream) {
        await this.#sendText(ws, ev.token);
      }
    };
    const sendPromise = sendLoop();

    try {
      await this.#createContext(ws);

      for await (const text of this.input) {
        if (text === tts.SynthesizeStream.FLUSH_SENTINEL) {
          tokenizerStream.flush();
        } else {
          tokenizerStream.pushText(text);
        }
      }
      tokenizerStream.endInput();
      await sendPromise;

      await this.#flushContext(ws);
      await this.#closeContext(ws);

      // Wait for the server to finish the context, but bound it so a stalled
      // server can't hang the turn forever. On timeout, throw a retryable
      // APITimeoutError so the framework restarts the turn.
      const waitTimeoutMs = this.connOptions.timeoutMs + 60_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new APITimeoutError({
              message: `Inworld synthesis timed out after ${waitTimeoutMs}ms`,
            }),
          );
        }, waitTimeoutMs);
        timer.unref?.();
      });
      try {
        await Promise.race([processing, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      // Flush remaining frames
      for (const frame of bstream.flush()) {
        sendLastFrame(false);
        lastFrame = frame;
      }
      sendLastFrame(true);
    } catch (e) {
      log().error({ error: e }, 'Error in SynthesizeStream run');
      throw e;
    } finally {
      ws.off('close', onClose);
      this.#tts.pool.unregisterListener(this.#contextId);
    }
  }

  #send(ws: WebSocket, data: object): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new APIConnectionError({ message: 'Inworld WebSocket not open' }));
        return;
      }
      ws.send(JSON.stringify(data), (err) => {
        if (err) {
          reject(
            new APIConnectionError({
              message: `Inworld WebSocket send failed: ${asError(err).message}`,
            }),
          );
        } else {
          resolve();
        }
      });
    });
  }

  #createContext(ws: WebSocket): Promise<void> {
    const config: CreateContextConfig = {
      voiceId: this.#opts.voice,
      modelId: this.#opts.model,
      audioConfig: {
        audioEncoding: this.#opts.encoding,
        sampleRateHertz: this.#opts.sampleRate,
        bitrate: this.#opts.bitRate,
        speakingRate: this.#opts.speakingRate,
      },
      temperature: this.#opts.temperature,
      language: this.#opts.language,
      bufferCharThreshold: this.#opts.bufferCharThreshold,
      maxBufferDelayMs: this.#opts.maxBufferDelayMs,
      timestampType: this.#opts.timestampType,
      applyTextNormalization: this.#opts.textNormalization,
      deliveryMode: this.#opts.deliveryMode,
      timestampTransportStrategy: this.#opts.timestampTransportStrategy,
      // Always enable auto_mode since we use sentence tokenizer and don't expose
      // mid-stream flush_context control to users yet
      autoMode: true,
    };

    return this.#send(ws, { create: config, contextId: this.#contextId });
  }

  #sendText(ws: WebSocket, text: string): Promise<void> {
    this.markStarted();
    return this.#send(ws, {
      send_text: { text },
      contextId: this.#contextId,
    });
  }

  #flushContext(ws: WebSocket): Promise<void> {
    return this.#send(ws, {
      flush_context: {},
      contextId: this.#contextId,
    });
  }

  #closeContext(ws: WebSocket): Promise<void> {
    return this.#send(ws, {
      close_context: {},
      contextId: this.#contextId,
    });
  }
}
