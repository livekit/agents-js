// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * REFACTORED: Persistent WebSocket Connection for ElevenLabs TTS
 *
 * Key improvements:
 * - Single persistent WebSocket per TTS instance (multi-stream API)
 * - Multiple TTS requests multiplexed via context IDs
 * - Efficient send/recv loops with proper lifecycle management
 * - Graceful connection draining when connection is replaced
 */
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

export interface TTSOptions {
  apiKey?: string;
  voice: Voice;
  modelID: TTSModels | string;
  languageCode?: string;
  baseURL: string;
  encoding: TTSEncoding;
  streamingLatency?: number;
  wordTokenizer: tokenize.WordTokenizer;
  chunkLengthSchedule?: number[];
  enableSsmlParsing: boolean;
  inactivityTimeout: number;
  syncAlignment: boolean;
  autoMode?: boolean;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.ELEVEN_API_KEY,
  voice: DEFAULT_VOICE,
  modelID: 'eleven_turbo_v2_5',
  baseURL: API_BASE_URL_V1,
  encoding: 'pcm_22050',
  wordTokenizer: new tokenize.basic.WordTokenizer(false),
  enableSsmlParsing: false,
  inactivityTimeout: DEFAULT_INACTIVITY_TIMEOUT,
  syncAlignment: true,
};

// ============================================================================
// WebSocket Connection Manager - Manages persistent connection with multi-stream support
// ============================================================================

interface StreamContext {
  contextId: string;
  eos: boolean;
  audioBuffer: Int8Array[];
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
    await new Promise<void>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not initialized'));
        return;
      }

      const ws = this.ws;
      let resolved = false;

      const openHandler = () => {
        resolved = true;
        ws.removeListener('open', openHandler);
        ws.removeListener('error', errorHandler);
        resolve();
      };

      const errorHandler = (error: Error) => {
        if (!resolved) {
          ws.removeListener('open', openHandler);
          reject(new Error(`WebSocket connection failed: ${error.message}`));
        }
      };

      ws.on('open', openHandler);
      ws.on('error', errorHandler);
    });

    // Start send and recv loops
    this.sendTask = this.sendLoop();
    this.recvTask = this.recvLoop();
  }

  registerContext(contextId: string): void {
    if (!this.contextData.has(contextId)) {
      this.contextData.set(contextId, {
        contextId,
        eos: false,
        audioBuffer: [],
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

  getContextAudio(contextId: string): Int8Array[] | null {
    return this.contextData.get(contextId)?.audioBuffer ?? null;
  }

  isContextEOS(contextId: string): boolean {
    return this.contextData.get(contextId)?.eos ?? false;
  }

  markNonCurrent(): void {
    this.isCurrent = false;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.inputQueue.close();

    this.contextData.clear();
    this.activeContexts.clear();

    if (this.ws) {
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

          const textPkt = {
            text: msg.text + ' ',
            context_id: msg.contextId,
          };

          this.ws.send(JSON.stringify(textPkt));

          if (msg.flush) {
            const flushPkt = {
              text: '',
              context_id: msg.contextId,
            };
            this.ws.send(JSON.stringify(flushPkt));
          }
        } else if (msg.type === 'close') {
          if (this.activeContexts.has(msg.contextId)) {
            const closePkt = {
              context_id: msg.contextId,
              close_context: true,
            };
            this.ws.send(JSON.stringify(closePkt));
            this.activeContexts.delete(msg.contextId);
          }
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Error in send loop');
    } finally {
      if (!this.closed) {
        await this.close();
      }
    }
  }

  private async recvLoop(): Promise<void> {
    try {
      while (!this.closed && this.ws && this.ws.readyState === 1) {
        const msg = await new Promise<RawData>((resolve, reject) => {
          if (!this.ws) {
            reject(new Error('WebSocket not available'));
            return;
          }

          const ws = this.ws;
          let resolved = false;

          const messageHandler = (data: RawData) => {
            if (!resolved) {
              resolved = true;
              ws.removeListener('message', messageHandler);
              ws.removeListener('close', closeHandler);
              ws.removeListener('error', errorHandler);
              resolve(data);
            }
          };

          const closeHandler = () => {
            if (!resolved) {
              resolved = true;
              ws.removeListener('message', messageHandler);
              ws.removeListener('error', errorHandler);
              reject(new Error('WebSocket closed'));
            }
          };

          const errorHandler = (error: Error) => {
            if (!resolved) {
              resolved = true;
              ws.removeListener('message', messageHandler);
              ws.removeListener('close', closeHandler);
              reject(error);
            }
          };

          ws.on('message', messageHandler);
          ws.on('close', closeHandler);
          ws.on('error', errorHandler);
        });

        try {
          const data = JSON.parse(msg.toString()) as Record<string, unknown>;
          const contextId = (data.contextId || data.context_id) as string | undefined;

          if (!contextId || !this.contextData.has(contextId)) {
            continue;
          }

          const context = this.contextData.get(contextId)!;

          if (data.error) {
            this.logger.error({ contextId, error: data.error }, 'ElevenLabs error');
            this.contextData.delete(contextId);
            continue;
          }

          if (data.audio) {
            const audioBuffer = Buffer.from(data.audio as string, 'base64');
            const audioArray = new Int8Array(audioBuffer);
            context.audioBuffer.push(audioArray);
          }

          if (data.isFinal) {
            context.eos = true;
            this.activeContexts.delete(contextId);

            if (!this.isCurrent && this.activeContexts.size === 0) {
              this.logger.debug('No active contexts, shutting down');
              break;
            }
          }
        } catch (parseError) {
          this.logger.warn({ parseError }, 'Failed to parse message');
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Recv loop error');
      for (const context of this.contextData.values()) {
        context.eos = true;
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
  #logger = log();
  #connection: WebSocketManager | null = null;
  #connectionLock: Promise<void> | null = null;
  label = 'elevenlabs.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    super(sampleRateFromFormat(opts.encoding || defaultTTSOptions.encoding), 1, {
      streaming: true,
    });

    this.#opts = {
      ...defaultTTSOptions,
      ...opts,
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

      const segments = new AsyncIterableQueue<tokenize.WordStream>();

      const tokenizeInput = async () => {
        let stream: tokenize.WordStream | null = null;
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

  private async runSynthesis(stream: tokenize.WordStream): Promise<void> {
    if (!this.#connection) {
      throw new Error('Connection not established');
    }

    const bstream = new AudioByteStream(sampleRateFromFormat(this.#opts.encoding), 1);

    const sendTask = async () => {
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

        this.#connection!.sendContent(this.#contextId, text, false);
      }

      if (xmlContent.length) {
        this.#logger.warn('Stream ended with incomplete XML content');
      }

      // Signal end of stream
      this.#connection!.sendContent(this.#contextId, '', true);
    };

    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({
          requestId: this.#contextId,
          segmentId,
          frame: lastFrame,
          final,
        });
        lastFrame = undefined;
      }
    };

    const listenTask = async () => {
      // Wait for EOS and collect audio
      while (!this.#connection!.isContextEOS(this.#contextId)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Get all audio buffers and process
      const audioBuffers = this.#connection!.getContextAudio(this.#contextId);
      if (audioBuffers) {
        for (const buffer of audioBuffers) {
          for (const frame of bstream.write(buffer)) {
            sendLastFrame(this.#contextId, false);
            lastFrame = frame;
          }
        }
      }

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
