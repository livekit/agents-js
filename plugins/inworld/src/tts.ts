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

export type Encoding = 'LINEAR16' | 'MP3' | 'OGG_OPUS' | 'ALAW' | 'MULAW' | 'FLAC' | string;
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

const defaultTTSOptionsBase: Omit<TTSOptions, 'tokenizer'> = {
  apiKey: process.env.INWORLD_API_KEY,
  voice: DEFAULT_VOICE,
  model: DEFAULT_MODEL,
  encoding: DEFAULT_ENCODING as Encoding,
  bitRate: DEFAULT_BIT_RATE,
  sampleRate: DEFAULT_SAMPLE_RATE,
  speakingRate: DEFAULT_SPEAKING_RATE,
  temperature: DEFAULT_TEMPERATURE,
  bufferCharThreshold: DEFAULT_BUFFER_CHAR_THRESHOLD,
  maxBufferDelayMs: DEFAULT_MAX_BUFFER_DELAY_MS,
  baseURL: DEFAULT_URL,
  wsURL: DEFAULT_WS_URL,
};

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

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

    this.#connecting = this.#connectWithRetry();
    return this.#connecting;
  }

  async #connectWithRetry(): Promise<WebSocket> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.#attemptConnection();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.#connecting = undefined;

        if (attempt < MAX_RETRIES) {
          // Exponential backoff: 1s, 2s
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

  #attemptConnection(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const wsUrl = new URL('tts/v1/voice:streamBidirectional', this.#url);
      if (wsUrl.protocol === 'https:') wsUrl.protocol = 'wss:';
      else if (wsUrl.protocol === 'http:') wsUrl.protocol = 'ws:';

      const ws = new WebSocket(wsUrl.toString(), {
        headers: { Authorization: this.#auth },
      });

      ws.on('open', () => {
        this.#ws = ws;
        this.#connecting = undefined;
        resolve(ws);
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
  #contextId: string;
  label = 'inworld.SynthesizeStream';

  constructor(ttsInstance: TTS, opts: TTSOptions) {
    super(ttsInstance);
    this.#tts = ttsInstance;
    this.#opts = opts;
    this.#contextId = shortuuid();
  }

  protected async run() {
    const ws = await this.#tts.pool.getConnection();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const tokenizerStream = this.#opts.tokenizer!.stream();

    let resolveProcessing: () => void;
    let rejectProcessing: (err: Error) => void;
    const processing = new Promise<void>((resolve, reject) => {
      resolveProcessing = resolve;
      rejectProcessing = reject;
    });

    const handleMessage = (msg: InworldMessage) => {
      const result = msg.result;
      if (!result) return;

      if (result.contextCreated) {
      } else if (result.contextClosed) {
        resolveProcessing();
      } else if (result.audioChunk) {
        if (result.audioChunk.timestampInfo) {
          const tsInfo = result.audioChunk.timestampInfo;
          if (tsInfo.wordAlignment) {
            const words = tsInfo.wordAlignment.words || [];
            const starts = tsInfo.wordAlignment.wordStartTimeSeconds || [];
            const ends = tsInfo.wordAlignment.wordEndTimeSeconds || [];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.#tts as any).emit('alignment', {
              requestId: this.#contextId,
              segmentId: this.#contextId,
              wordAlignment: { words, starts, ends },
            });
          }

          if (tsInfo.characterAlignment) {
            const chars = tsInfo.characterAlignment.characters || [];
            const starts = tsInfo.characterAlignment.characterStartTimeSeconds || [];
            const ends = tsInfo.characterAlignment.characterEndTimeSeconds || [];

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
              this.queue.put({
                requestId: this.#contextId,
                segmentId: this.#contextId,
                frame,
                final: false,
              });
            }
          }
        }
      } else if (result.status && result.status.code !== 0) {
        const error = new Error(`Inworld stream error: ${result.status.message}`);
        rejectProcessing(error);
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
      await processing;

      // Flush remaining frames
      for (const frame of bstream.flush()) {
        this.queue.put({
          requestId: this.#contextId,
          segmentId: this.#contextId,
          frame,
          final: false,
        });
      }
    } catch (e) {
      log().error({ error: e }, 'Error in SynthesizeStream run');
      throw e;
    } finally {
      this.#tts.pool.unregisterListener(this.#contextId);
    }
  }

  #send(ws: WebSocket, data: object): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not open'));
        return;
      }
      ws.send(JSON.stringify(data), (err) => {
        if (err) {
          reject(err);
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
      bufferCharThreshold: this.#opts.bufferCharThreshold,
      maxBufferDelayMs: this.#opts.maxBufferDelayMs,
      timestampType: this.#opts.timestampType,
      applyTextNormalization: this.#opts.textNormalization,
    };

    return this.#send(ws, { create: config, contextId: this.#contextId });
  }

  #sendText(ws: WebSocket, text: string): Promise<void> {
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
