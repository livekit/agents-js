// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AudioByteStream,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import { type RawData, WebSocket } from 'ws';

const DEFAULT_BIT_RATE = 64000;
const DEFAULT_ENCODING = 'LINEAR16';
const DEFAULT_MODEL = 'inworld-tts-1';
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_URL = 'https://api.inworld.ai/';
const DEFAULT_WS_URL = 'wss://api.inworld.ai/';
const DEFAULT_VOICE = 'Ashley';
const DEFAULT_TEMPERATURE = 1.1;
const DEFAULT_SPEAKING_RATE = 1.0;
const DEFAULT_BUFFER_CHAR_THRESHOLD = 100;
const DEFAULT_MAX_BUFFER_DELAY_MS = 3000;
const NUM_CHANNELS = 1;

export type Encoding = 'LINEAR16' | 'MP3' | 'OGG_OPUS' | 'ALAW' | 'MULAW' | 'FLAC';
export type TimestampType = 'TIMESTAMP_TYPE_UNSPECIFIED' | 'WORD' | 'CHARACTER';
export type TextNormalization = 'APPLY_TEXT_NORMALIZATION_UNSPECIFIED' | 'ON' | 'OFF';

export interface TTSOptions {
  apiKey?: string;
  voice: string;
  model: string;
  encoding: Encoding;
  bitRate: number;
  sampleRate: number;
  speakingRate: number;
  temperature: number;
  timestampType?: TimestampType;
  textNormalization?: TextNormalization;
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
  timestampType?: TimestampType;
  applyTextNormalization?: TextNormalization;
}

interface CreateContextConfig {
  voiceId: string;
  modelId: string;
  audioConfig: AudioConfig;
  temperature: number;
  bufferCharThreshold: number;
  maxBufferDelayMs: number;
  timestampType?: TimestampType;
  applyTextNormalization?: TextNormalization;
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

// Connection pooling types
enum ContextState {
  CREATING = 'creating',
  ACTIVE = 'active',
  CLOSING = 'closing',
}

interface ContextInfo {
  contextId: string;
  state: ContextState;
  listener: (msg: InworldMessage) => void;
  resolveWaiter: (() => void) | null;
  rejectWaiter: ((err: Error) => void) | null;
  createdAt: number;
}

interface AcquireContextResult {
  contextId: string;
  connection: InworldConnection;
  waiter: Promise<void>;
}

const defaultTTSOptionsBase: Omit<TTSOptions, 'tokenizer'> = {
  apiKey: process.env.INWORLD_API_KEY,
  voice: DEFAULT_VOICE,
  model: DEFAULT_MODEL,
  encoding: DEFAULT_ENCODING,
  bitRate: DEFAULT_BIT_RATE,
  sampleRate: DEFAULT_SAMPLE_RATE,
  speakingRate: DEFAULT_SPEAKING_RATE,
  temperature: DEFAULT_TEMPERATURE,
  bufferCharThreshold: DEFAULT_BUFFER_CHAR_THRESHOLD,
  maxBufferDelayMs: DEFAULT_MAX_BUFFER_DELAY_MS,
  baseURL: DEFAULT_URL,
  wsURL: DEFAULT_WS_URL,
};

// Connection pooling constants
const MAX_CONNECTIONS = 20;
const MAX_CONTEXTS_PER_CONNECTION = 5;
const IDLE_CONNECTION_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_SESSION_DURATION_MS = 300_000; // 5 minutes max session duration
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const MAX_TEXT_CHUNK_SIZE = 1000; // Inworld API limit: max 1000 characters per send_text request

/**
 * Manages a single WebSocket connection with up to MAX_CONTEXTS_PER_CONNECTION concurrent contexts.
 */
class InworldConnection {
  #ws?: WebSocket;
  #url: string;
  #auth: string;
  #connecting?: Promise<void>;
  #contexts: Map<string, ContextInfo> = new Map();
  #logger = log();
  #connectionCreatedAt?: number;
  #lastActivityAt: number = Date.now();
  #onCapacityAvailable?: () => void;
  #closed = false;

  constructor(url: string, auth: string, onCapacityAvailable?: () => void) {
    this.#url = url;
    this.#auth = auth;
    this.#onCapacityAvailable = onCapacityAvailable;
  }

  get contextCount(): number {
    return this.#contexts.size;
  }

  get hasCapacity(): boolean {
    return this.#contexts.size < MAX_CONTEXTS_PER_CONNECTION && !this.#closed;
  }

  get isIdle(): boolean {
    return this.#contexts.size === 0;
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  get isSessionExpired(): boolean {
    if (!this.#connectionCreatedAt) return false;
    return Date.now() - this.#connectionCreatedAt >= MAX_SESSION_DURATION_MS;
  }

  get isConnected(): boolean {
    return this.#ws !== undefined && this.#ws.readyState === WebSocket.OPEN && !this.#closed;
  }

  async acquireContext(
    listener: (msg: InworldMessage) => void,
    config: CreateContextConfig,
  ): Promise<{ contextId: string; waiter: Promise<void> }> {
    if (!this.hasCapacity) {
      throw new Error('Connection has no capacity for new contexts');
    }

    // Ensure connection is established
    await this.#ensureConnected();

    const contextId = shortuuid();
    let resolveWaiter: (() => void) | null = null;
    let rejectWaiter: ((err: Error) => void) | null = null;

    const waiter = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });

    const contextInfo: ContextInfo = {
      contextId,
      state: ContextState.CREATING,
      listener,
      resolveWaiter,
      rejectWaiter,
      createdAt: Date.now(),
    };

    this.#contexts.set(contextId, contextInfo);
    this.#lastActivityAt = Date.now();

    // Send create context command
    try {
      await this.#sendCreateContext(contextId, config);
    } catch (err) {
      // Clean up context on failure to prevent leak
      this.#contexts.delete(contextId);
      if (this.#onCapacityAvailable) {
        this.#onCapacityAvailable();
      }
      throw err;
    }

    return { contextId, waiter };
  }

  async sendText(contextId: string, text: string): Promise<void> {
    const context = this.#contexts.get(contextId);
    if (!context) {
      throw new Error(`Context ${contextId} not found`);
    }
    this.#lastActivityAt = Date.now();
    await this.#send({ send_text: { text }, contextId });
  }

  async flushContext(contextId: string): Promise<void> {
    const context = this.#contexts.get(contextId);
    if (!context) {
      throw new Error(`Context ${contextId} not found`);
    }
    this.#lastActivityAt = Date.now();
    await this.#send({ flush_context: {}, contextId });
  }

  async closeContext(contextId: string): Promise<void> {
    const context = this.#contexts.get(contextId);
    if (!context) {
      return; // Already closed
    }
    context.state = ContextState.CLOSING;
    this.#lastActivityAt = Date.now();
    await this.#send({ close_context: {}, contextId });
  }

  async #ensureConnected(): Promise<void> {
    // Check if existing connection is valid
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN && !this.isSessionExpired) {
      return;
    }

    // If session expired, close and reconnect
    if (this.#ws && this.isSessionExpired) {
      this.#logger.debug('Inworld WebSocket session expired, reconnecting');
      this.#ws.close();
      this.#ws = undefined;
    }

    if (this.#connecting) {
      return this.#connecting;
    }

    this.#connecting = this.#connectWithRetry();
    return this.#connecting;
  }

  async #connectWithRetry(): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.#attemptConnection();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.#connecting = undefined;

        if (attempt < MAX_RETRIES) {
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          this.#logger.warn(
            { error: lastError, attempt: attempt + 1, maxRetries: MAX_RETRIES + 1, delayMs },
            `Failed to connect to Inworld, retrying in ${delayMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw new Error(
      `Failed to connect to Inworld after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
    );
  }

  #attemptConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = new URL('tts/v1/voice:streamBidirectional', this.#url);
      if (wsUrl.protocol === 'https:') wsUrl.protocol = 'wss:';
      else if (wsUrl.protocol === 'http:') wsUrl.protocol = 'ws:';

      const ws = new WebSocket(wsUrl.toString(), {
        headers: { Authorization: this.#auth },
      });

      ws.on('open', () => {
        this.#ws = ws;
        this.#connectionCreatedAt = Date.now();
        this.#connecting = undefined;
        this.#logger.debug('Established new Inworld TTS WebSocket connection');
        resolve();
      });

      ws.on('error', (err) => {
        if (this.#connecting) {
          reject(err);
        } else {
          this.#logger.error({ err }, 'Inworld WebSocket error');
        }
      });

      ws.on('close', () => {
        this.#ws = undefined;
        this.#connecting = undefined;
        // Reject all pending context waiters
        for (const context of this.#contexts.values()) {
          if (context.rejectWaiter) {
            context.rejectWaiter(new Error('WebSocket connection closed'));
          }
        }
        this.#contexts.clear();
      });

      ws.on('message', (data: RawData) => {
        this.#handleMessage(data);
      });
    });
  }

  #handleMessage(data: RawData): void {
    try {
      const json = JSON.parse(data.toString()) as InworldMessage;
      const result = json.result;

      if (result) {
        const contextId = result.contextId || json.contextId;
        if (!contextId) return;

        const context = this.#contexts.get(contextId);
        if (!context) return;

        // Handle context created
        if (result.contextCreated) {
          context.state = ContextState.ACTIVE;
          this.#logger.debug({ contextId }, 'Inworld context created');
        }

        // Handle context closed - remove from map and notify pool
        if (result.contextClosed) {
          this.#logger.debug({ contextId }, 'Inworld context closed');
          const ctx = this.#contexts.get(contextId);
          this.#contexts.delete(contextId);
          if (ctx?.resolveWaiter) {
            ctx.resolveWaiter();
          }
          // Notify pool that capacity is available
          if (this.#onCapacityAvailable) {
            this.#onCapacityAvailable();
          }
          return;
        }

        // Handle errors - remove context and notify capacity
        if (result.status && result.status.code !== 0) {
          this.#logger.error({ contextId, status: result.status }, 'Inworld stream error');
          const ctx = this.#contexts.get(contextId);
          this.#contexts.delete(contextId);
          if (ctx?.rejectWaiter) {
            ctx.rejectWaiter(new Error(`Inworld error: ${result.status.message}`));
          }
          // Notify pool that capacity is available
          if (this.#onCapacityAvailable) {
            this.#onCapacityAvailable();
          }
          return;
        }

        // Forward message to listener
        context.listener(json);
      } else if (json.error) {
        this.#logger.warn({ error: json.error }, 'Inworld received error message');
      }
    } catch (e) {
      this.#logger.warn({ error: e }, 'Failed to parse Inworld WebSocket message');
    }
  }

  #send(data: object): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not open'));
        return;
      }
      this.#ws.send(JSON.stringify(data), (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async #sendCreateContext(contextId: string, config: CreateContextConfig): Promise<void> {
    await this.#send({ create: config, contextId });
  }

  close(): void {
    this.#closed = true;
    if (this.#ws) {
      this.#ws.close();
      this.#ws = undefined;
    }
  }
}

/**
 * Connection pool managing up to MAX_CONNECTIONS WebSocket connections.
 * Each connection can handle up to MAX_CONTEXTS_PER_CONNECTION concurrent contexts.
 */
class ConnectionPool {
  #connections: InworldConnection[] = [];
  #url: string;
  #auth: string;
  #logger = log();
  #capacityWaiters: (() => void)[] = [];
  #idleCleanupInterval?: ReturnType<typeof setInterval>;

  constructor(url: string, auth: string) {
    this.#url = url;
    this.#auth = auth;

    // Start idle connection cleanup
    // Use unref() to prevent this interval from keeping the process alive
    this.#idleCleanupInterval = setInterval(() => {
      this.#cleanupIdleConnections();
    }, 60_000); // Check every minute
    this.#idleCleanupInterval.unref?.();
  }

  async acquireContext(
    listener: (msg: InworldMessage) => void,
    config: CreateContextConfig,
  ): Promise<AcquireContextResult> {
    // Find a connection with capacity
    let connection = this.#findConnectionWithCapacity();

    // If no connection has capacity, try to create a new one
    if (!connection && this.#connections.length < MAX_CONNECTIONS) {
      connection = this.#createConnection();
    }

    // If at limit, wait for capacity
    if (!connection) {
      this.#logger.debug('All connections at capacity, waiting for availability');
      await this.#waitForCapacity();
      connection = this.#findConnectionWithCapacity();
      if (!connection && this.#connections.length < MAX_CONNECTIONS) {
        connection = this.#createConnection();
      }
      if (!connection) {
        throw new Error('Failed to acquire connection after waiting');
      }
    }

    const { contextId, waiter } = await connection.acquireContext(listener, config);
    return { contextId, connection, waiter };
  }

  #findConnectionWithCapacity(): InworldConnection | undefined {
    // Prefer connections that are already connected and have capacity
    for (const conn of this.#connections) {
      if (conn.hasCapacity && conn.isConnected && !conn.isSessionExpired) {
        return conn;
      }
    }
    // Fall back to any connection with capacity
    for (const conn of this.#connections) {
      if (conn.hasCapacity && !conn.isSessionExpired) {
        return conn;
      }
    }
    return undefined;
  }

  #createConnection(): InworldConnection {
    const connection = new InworldConnection(this.#url, this.#auth, () => {
      this.#notifyCapacityAvailable();
    });
    this.#connections.push(connection);
    this.#logger.debug(
      { connectionCount: this.#connections.length },
      'Created new Inworld connection',
    );
    return connection;
  }

  #waitForCapacity(): Promise<void> {
    return new Promise((resolve) => {
      this.#capacityWaiters.push(resolve);
    });
  }

  #notifyCapacityAvailable(): void {
    const waiter = this.#capacityWaiters.shift();
    if (waiter) {
      waiter();
    }
  }

  #cleanupIdleConnections(): void {
    const now = Date.now();
    const toRemove: InworldConnection[] = [];

    for (const conn of this.#connections) {
      if (conn.isIdle && now - conn.lastActivityAt > IDLE_CONNECTION_TIMEOUT_MS) {
        toRemove.push(conn);
      }
    }

    for (const conn of toRemove) {
      const index = this.#connections.indexOf(conn);
      if (index !== -1) {
        this.#connections.splice(index, 1);
        conn.close();
        this.#logger.debug(
          { connectionCount: this.#connections.length },
          'Closed idle Inworld connection',
        );
      }
    }
  }

  close(): void {
    if (this.#idleCleanupInterval) {
      clearInterval(this.#idleCleanupInterval);
      this.#idleCleanupInterval = undefined;
    }
    for (const conn of this.#connections) {
      conn.close();
    }
    this.#connections = [];
  }
}

// Module-level singleton pool per API key with reference counting
const sharedPools = new Map<string, ConnectionPool>();
const sharedPoolRefs = new Map<string, number>();

function getSharedPoolKey(wsUrl: string, authorization: string): string {
  return `${wsUrl}:${authorization}`;
}

function acquireSharedPool(wsUrl: string, authorization: string): ConnectionPool {
  const key = getSharedPoolKey(wsUrl, authorization);
  let pool = sharedPools.get(key);
  if (!pool) {
    pool = new ConnectionPool(wsUrl, authorization);
    sharedPools.set(key, pool);
    sharedPoolRefs.set(key, 0);
  }
  sharedPoolRefs.set(key, (sharedPoolRefs.get(key) || 0) + 1);
  return pool;
}

function releaseSharedPool(wsUrl: string, authorization: string): void {
  const key = getSharedPoolKey(wsUrl, authorization);
  const refCount = (sharedPoolRefs.get(key) || 1) - 1;
  if (refCount <= 0) {
    const pool = sharedPools.get(key);
    if (pool) {
      pool.close();
      sharedPools.delete(key);
    }
    sharedPoolRefs.delete(key);
  } else {
    sharedPoolRefs.set(key, refCount);
  }
}

// Export for testing
export { InworldConnection, ConnectionPool, MAX_CONTEXTS_PER_CONNECTION, MAX_CONNECTIONS };

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #authorization: string;
  #pool: ConnectionPool;
  label = 'inworld.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const mergedOpts = { ...defaultTTSOptionsBase, ...opts };
    if (!mergedOpts.apiKey) {
      throw new Error('Inworld API key required. Set INWORLD_API_KEY or provide apiKey.');
    }

    super(mergedOpts.sampleRate, NUM_CHANNELS, {
      streaming: true,
    });

    this.#opts = mergedOpts as TTSOptions;
    if (!this.#opts.tokenizer) {
      this.#opts.tokenizer = new tokenize.basic.SentenceTokenizer({ retainFormat: true });
    }
    this.#authorization = `Basic ${mergedOpts.apiKey}`;
    this.#pool = acquireSharedPool(this.#opts.wsURL, this.#authorization);
  }

  get pool(): ConnectionPool {
    return this.#pool;
  }

  get opts(): TTSOptions {
    return this.#opts;
  }

  get authorization(): string {
    return this.#authorization;
  }

  get wsURL(): string {
    return this.#opts.wsURL;
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

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: this.#authorization,
      },
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(
        `Inworld API error: ${response.status} ${response.statusText}${errorBody.message ? ` - ${errorBody.message}` : ''}`,
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

  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts);
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };
    if (opts.apiKey) {
      this.#authorization = `Basic ${opts.apiKey}`;
    }
  }

  async close() {
    releaseSharedPool(this.#opts.wsURL, this.#authorization);
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
      timestampType: this.#opts.timestampType,
      applyTextNormalization: this.#opts.textNormalization,
    };

    const url = new URL('tts/v1/voice:stream', this.#opts.baseURL);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: this.#tts.authorization,
          'Content-Type': 'application/json',
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
      throw new Error(`Inworld API error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const requestId = shortuuid();
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
                    requestId,
                    segmentId: requestId,
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
        requestId,
        segmentId: requestId,
        frame,
        final: false,
      });
    }
  }
}

class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #tts: TTS;
  #logger = log();
  label = 'inworld.SynthesizeStream';

  constructor(ttsInstance: TTS, opts: TTSOptions) {
    super(ttsInstance);
    this.#tts = ttsInstance;
    this.#opts = opts;
  }

  protected async run() {
    const pool = this.#tts.pool;
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const tokenizerStream = this.#opts.tokenizer!.stream();

    // Build context config
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
      bufferCharThreshold: this.#opts.bufferCharThreshold,
      maxBufferDelayMs: this.#opts.maxBufferDelayMs,
      timestampType: this.#opts.timestampType,
      applyTextNormalization: this.#opts.textNormalization,
    };

    let contextId: string | undefined;
    let connection: InworldConnection | undefined;
    let waiter: Promise<void> | undefined;

    const handleMessage = (msg: InworldMessage) => {
      const result = msg.result;
      if (!result) return;

      // Handle audio chunks
      if (result.audioChunk) {
        if (result.audioChunk.timestampInfo) {
          const tsInfo = result.audioChunk.timestampInfo;
          if (tsInfo.wordAlignment) {
            const words = tsInfo.wordAlignment.words || [];
            const starts = tsInfo.wordAlignment.wordStartTimeSeconds || [];
            const ends = tsInfo.wordAlignment.wordEndTimeSeconds || [];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.#tts as any).emit('alignment', {
              requestId: contextId,
              segmentId: contextId,
              wordAlignment: { words, starts, ends },
            });
          }

          if (tsInfo.characterAlignment) {
            const chars = tsInfo.characterAlignment.characters || [];
            const starts = tsInfo.characterAlignment.characterStartTimeSeconds || [];
            const ends = tsInfo.characterAlignment.characterEndTimeSeconds || [];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.#tts as any).emit('alignment', {
              requestId: contextId,
              segmentId: contextId,
              characterAlignment: { chars, starts, ends },
            });
          }
        }

        if (result.audioChunk.audioContent) {
          const b64Content = result.audioChunk.audioContent;
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
              this.queue.put({
                requestId: contextId!,
                segmentId: contextId!,
                frame,
                final: false,
              });
            }
          }
        }
      }
    };

    try {
      // Acquire a context from the shared pool
      const acquired = await pool.acquireContext(handleMessage, config);
      contextId = acquired.contextId;
      connection = acquired.connection;
      waiter = acquired.waiter;

      this.#logger.debug({ contextId }, 'Acquired context from pool');

      // Send loop - sends text to the connection as sentences are tokenized
      const sendLoop = async () => {
        for await (const ev of tokenizerStream) {
          const text = ev.token;
          // Chunk text to stay within API limits
          for (let i = 0; i < text.length; i += MAX_TEXT_CHUNK_SIZE) {
            const chunk = text.slice(i, i + MAX_TEXT_CHUNK_SIZE);
            await connection!.sendText(contextId!, chunk);
          }
        }
      };
      const sendPromise = sendLoop();

      // Process input and push to tokenizer
      for await (const text of this.input) {
        if (text === tts.SynthesizeStream.FLUSH_SENTINEL) {
          tokenizerStream.flush();
        } else {
          tokenizerStream.pushText(text);
        }
      }
      tokenizerStream.endInput();

      // Wait for all text to be sent
      await sendPromise;

      // Flush and close context
      await connection.flushContext(contextId);
      await connection.closeContext(contextId);

      // Wait for context to be fully closed by server
      await waiter;

      // Flush remaining frames from the audio byte stream
      for (const frame of bstream.flush()) {
        this.queue.put({
          requestId: contextId,
          segmentId: contextId,
          frame,
          final: false,
        });
      }
    } catch (e) {
      this.#logger.error({ error: e, contextId }, 'Error in SynthesizeStream run');
      throw e;
    }
  }
}
