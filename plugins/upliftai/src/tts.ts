// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APITimeoutError,
  AsyncIterableQueue,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';
import { Manager } from 'socket.io-client';

export type OutputFormat =
  | 'PCM_22050_16'
  | 'WAV_22050_16'
  | 'WAV_22050_32'
  | 'MP3_22050_32'
  | 'MP3_22050_64'
  | 'MP3_22050_128'
  | 'OGG_22050_16'
  | 'ULAW_8000_8';

export interface VoiceSettings {
  voiceId: string;
  outputFormat: OutputFormat;
}

export interface TTSOptions {
  apiKey?: string;
  baseURL?: string;
  voiceId?: string;
  outputFormat?: OutputFormat;
  tokenizer?: tokenize.WordTokenizer | tokenize.SentenceTokenizer;
  /**
   * The timeout for the next audio chunk to be received from the UpliftAI API.
   * Default: 10000ms
   */
  chunkTimeout?: number;
}

const DEFAULT_BASE_URL = 'wss://api.upliftai.org';
const DEFAULT_SAMPLE_RATE = 22050;
const DEFAULT_NUM_CHANNELS = 1;
const DEFAULT_VOICE_ID = 'v_meklc281';
const DEFAULT_OUTPUT_FORMAT: OutputFormat = 'PCM_22050_16';
const WEBSOCKET_NAMESPACE = '/text-to-speech/multi-stream';
const DEFAULT_CHUNK_TIMEOUT = 10000;

const getSampleRateFromFormat = (outputFormat: OutputFormat): number => {
  if (outputFormat === 'ULAW_8000_8') {
    return 8000;
  }
  return DEFAULT_SAMPLE_RATE;
};

export class TTS extends tts.TTS {
  #apiKey: string;
  #baseURL: string;
  #voiceSettings: VoiceSettings;
  #tokenizer: tokenize.WordTokenizer | tokenize.SentenceTokenizer;
  #client: WebSocketClient | null = null;
  #logger = log();
  #chunkTimeout: number;
  label = 'upliftai.TTS';

  constructor(opts: TTSOptions = {}) {
    const outputFormat = opts.outputFormat || DEFAULT_OUTPUT_FORMAT;
    const sampleRate = getSampleRateFromFormat(outputFormat);

    super(sampleRate, DEFAULT_NUM_CHANNELS, {
      streaming: true,
    });

    this.#apiKey = opts.apiKey || process.env.UPLIFTAI_API_KEY || '';
    if (!this.#apiKey) {
      throw new Error(
        'UpliftAI API key is required, either as argument or set UPLIFTAI_API_KEY environment variable',
      );
    }

    this.#baseURL = opts.baseURL || process.env.UPLIFTAI_BASE_URL || DEFAULT_BASE_URL;
    this.#voiceSettings = {
      voiceId: opts.voiceId || DEFAULT_VOICE_ID,
      outputFormat,
    };
    this.#tokenizer = opts.tokenizer || new tokenize.basic.SentenceTokenizer();
    this.#chunkTimeout = opts.chunkTimeout || DEFAULT_CHUNK_TIMEOUT;
  }

  synthesize(
    text: string,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
  ): tts.ChunkedStream {
    return new ChunkedStream(
      this,
      this.#apiKey,
      this.#baseURL,
      this.#voiceSettings,
      text,
      this.#chunkTimeout,
      connOptions,
    );
  }

  stream(connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS): tts.SynthesizeStream {
    return new SynthesizeStream(
      this,
      this.#apiKey,
      this.#baseURL,
      this.#voiceSettings,
      this.#tokenizer,
      this.#chunkTimeout,
      connOptions,
    );
  }

  async close() {
    if (this.#client) {
      await this.#client.disconnect();
      this.#client = null;
    }
  }
}

interface AudioMessage {
  type: string;
  requestId?: string;
  audio?: string;
  message?: string;
  sessionId?: string;
}

class WebSocketClient extends EventEmitter {
  private manager: Manager;
  private socket: Socket | null = null;
  private connected = false;
  private audioCallbacks: Map<string, AsyncIterableQueue<Buffer | null>> = new Map();
  private logger = log();

  constructor(
    private apiKey: string,
    private baseURL: string,
  ) {
    super();
    this.manager = new Manager(this.baseURL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 1000,
      autoConnect: false,
    });
  }

  async connect(): Promise<boolean> {
    if (this.connected) {
      return true;
    }

    try {
      this.socket = this.manager.socket(WEBSOCKET_NAMESPACE, {
        auth: {
          token: this.apiKey,
        },
      });

      this.socket.on('connect', () => {
        this.logger.debug('WebSocket connected to UpliftAI');
      });

      this.socket.on('disconnect', () => {
        this.connected = false;
        this.logger.debug('WebSocket disconnected from UpliftAI');
        // Close all active queues
        for (const queue of this.audioCallbacks.values()) {
          if (!queue.closed) {
            queue.put(null);
            queue.close();
          }
        }
        this.audioCallbacks.clear();
      });

      this.socket.on('message', (data: AudioMessage) => {
        this.handleMessage(data);
      });

      this.socket.connect();

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(false);
        }, 5000);

        const handleReady = (data: AudioMessage) => {
          if (data.type === 'ready') {
            this.connected = true;
            clearTimeout(timeout);
            this.socket!.off('message', handleReady);
            resolve(true);
          }
        };
        this.socket!.on('message', handleReady);
      });
    } catch (error) {
      this.logger.error('Failed to connect to UpliftAI:', error);
      return false;
    }
  }

  async synthesize(
    text: string,
    voiceSettings: VoiceSettings,
  ): Promise<AsyncIterableQueue<Buffer | null>> {
    if (!this.socket || !this.connected) {
      if (!(await this.connect())) {
        throw new APIConnectionError({ message: 'Failed to connect to UpliftAI service' });
      }
    }

    // Always create a new request ID for each synthesis request
    const requestId = shortuuid();

    // Create a new audio queue for this request
    const audioQueue = new AsyncIterableQueue<Buffer | null>();
    this.audioCallbacks.set(requestId, audioQueue);

    const message = {
      type: 'synthesize',
      requestId,
      text,
      voiceId: voiceSettings.voiceId,
      outputFormat: voiceSettings.outputFormat,
    };

    this.logger.debug(`Sending synthesis request ${requestId} for text: "${text.slice(0, 50)}..."`);

    try {
      this.socket!.emit('synthesize', message);
    } catch (error) {
      this.logger.error('Failed to emit synthesis:', error);
      this.audioCallbacks.delete(requestId);
      audioQueue.close();
      throw error;
    }

    return audioQueue;
  }

  private handleMessage(data: AudioMessage) {
    const messageType = data.type;

    if (messageType === 'ready') {
      this.connected = true;
      this.logger.debug(`Ready with session: ${data.sessionId}`);
    } else if (messageType === 'audio') {
      const requestId = data.requestId;
      const audioB64 = data.audio;

      if (audioB64 && requestId && this.audioCallbacks.has(requestId)) {
        const audioBytes = Buffer.from(audioB64, 'base64');
        const queue = this.audioCallbacks.get(requestId);
        if (queue && !queue.closed) {
          try {
            queue.put(audioBytes);
          } catch (error) {
            this.logger.debug(`Queue closed for ${requestId}, ignoring audio data`);
          }
        }
      }
    } else if (messageType === 'audio_end') {
      const requestId = data.requestId;
      if (requestId && this.audioCallbacks.has(requestId)) {
        const queue = this.audioCallbacks.get(requestId);
        if (queue && !queue.closed) {
          queue.put(null);
          queue.close();
        }
        this.audioCallbacks.delete(requestId);
      }
    } else if (messageType === 'error') {
      const requestId = data.requestId || 'unknown';
      const errorMsg = data.message || JSON.stringify(data);
      this.logger.error(`Error for ${requestId}: ${errorMsg}`);

      if (requestId !== 'unknown' && this.audioCallbacks.has(requestId)) {
        const queue = this.audioCallbacks.get(requestId);
        if (queue && !queue.closed) {
          queue.put(null);
          queue.close();
        }
        this.audioCallbacks.delete(requestId);
      }
    }
  }

  async disconnect() {
    if (this.socket) {
      // Clean up all active requests before disconnecting
      for (const queue of this.audioCallbacks.values()) {
        if (!queue.closed) {
          queue.close();
        }
      }
      this.audioCallbacks.clear();

      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  #apiKey: string;
  #baseURL: string;
  #voiceSettings: VoiceSettings;
  #client: WebSocketClient | null = null;
  #logger = log();
  #chunkTimeout: number;
  label = 'upliftai.ChunkedStream';

  constructor(
    tts: TTS,
    apiKey: string,
    baseURL: string,
    voiceSettings: VoiceSettings,
    inputText: string,
    chunkTimeout: number,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
  ) {
    super(inputText, tts, connOptions);
    this.#apiKey = apiKey;
    this.#baseURL = baseURL;
    this.#voiceSettings = voiceSettings;
    this.#chunkTimeout = chunkTimeout;
  }

  protected async run() {
    const requestId = shortuuid();
    const sampleRate = getSampleRateFromFormat(this.#voiceSettings.outputFormat);

    try {
      if (!this.#client) {
        this.#client = new WebSocketClient(this.#apiKey, this.#baseURL);
      }

      const audioQueue = await this.#client.synthesize(this.inputText, this.#voiceSettings);

      const bstream = new AudioByteStream(sampleRate, DEFAULT_NUM_CHANNELS);
      let lastFrame: AudioFrame | undefined;

      const sendLastFrame = (final: boolean) => {
        if (lastFrame) {
          this.queue.put({
            requestId,
            segmentId: requestId,
            frame: lastFrame,
            final,
          });
          lastFrame = undefined;
        }
      };

      let timeoutId: NodeJS.Timeout | null = null;
      const clearChunkTimeout = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      let hasReceivedData = false;

      try {
        // Set timeout for first chunk
        timeoutId = setTimeout(() => {
          if (!hasReceivedData && !audioQueue.closed) {
            this.#logger.warn(`No audio received after ${this.#chunkTimeout}ms`);
            audioQueue.put(null);
            audioQueue.close();
          }
        }, this.#chunkTimeout);

        for await (const audioData of audioQueue) {
          if (!hasReceivedData) {
            clearChunkTimeout();
            hasReceivedData = true;
          }

          if (audioData === null) {
            this.#logger.debug('Audio stream ended');
            break;
          }

          const audioArray =
            audioData instanceof Buffer
              ? (audioData.buffer.slice(
                  audioData.byteOffset,
                  audioData.byteOffset + audioData.byteLength,
                ) as ArrayBuffer)
              : ((audioData as Uint8Array).buffer as ArrayBuffer);
          for (const frame of bstream.write(audioArray)) {
            sendLastFrame(false);
            lastFrame = frame;
          }
        }
      } finally {
        clearChunkTimeout();
      }

      // Flush remaining data
      for (const frame of bstream.flush()) {
        sendLastFrame(false);
        lastFrame = frame;
      }

      // Send the last frame as final
      sendLastFrame(true);

      // Close the queue
      this.queue.close();
    } catch (error) {
      if (error instanceof APITimeoutError) {
        throw error;
      }
      throw new APIConnectionError({
        message: `TTS synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #apiKey: string;
  #baseURL: string;
  #voiceSettings: VoiceSettings;
  #tokenizer: tokenize.WordTokenizer | tokenize.SentenceTokenizer;
  #client: WebSocketClient | null = null;
  #logger = log();
  #chunkTimeout: number;
  label = 'upliftai.SynthesizeStream';

  constructor(
    tts: TTS,
    apiKey: string,
    baseURL: string,
    voiceSettings: VoiceSettings,
    tokenizer: tokenize.WordTokenizer | tokenize.SentenceTokenizer,
    chunkTimeout: number,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
  ) {
    super(tts, connOptions);
    this.#apiKey = apiKey;
    this.#baseURL = baseURL;
    this.#voiceSettings = voiceSettings;
    this.#tokenizer = tokenizer;
    this.#chunkTimeout = chunkTimeout;
  }

  protected async run() {
    const segments = new AsyncIterableQueue<tokenize.WordStream | tokenize.SentenceStream>();

    const tokenizeInput = async () => {
      let stream: tokenize.WordStream | tokenize.SentenceStream | null = null;

      try {
        for await (const text of this.input) {
          if (this.abortController.signal.aborted) {
            break;
          }

          if (text === SynthesizeStream.FLUSH_SENTINEL) {
            if (stream) {
              stream.endInput();
              stream = null;
            }
          } else {
            if (!stream) {
              stream = this.#tokenizer.stream();
              segments.put(stream);
            }
            stream.pushText(text);
          }
        }

        if (stream) {
          stream.endInput();
        }
      } finally {
        segments.close();
      }
    };

    const processSegments = async () => {
      for await (const wordStream of segments) {
        if (this.abortController.signal.aborted) {
          break;
        }
        await this.runSegment(wordStream);
      }
    };

    try {
      await Promise.all([tokenizeInput(), processSegments()]);
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        throw error;
      }
    }
  }

  private async runSegment(wordStream: tokenize.WordStream | tokenize.SentenceStream) {
    // Each segment gets its own unique IDs
    const segmentId = shortuuid();
    const requestId = shortuuid();
    const sampleRate = getSampleRateFromFormat(this.#voiceSettings.outputFormat);

    if (this.abortController.signal.aborted) {
      return;
    }

    try {
      if (!this.#client) {
        this.#client = new WebSocketClient(this.#apiKey, this.#baseURL);
      }

      // Collect text from tokenizer
      const textParts: string[] = [];
      for await (const data of wordStream) {
        textParts.push(data.token);
      }

      if (!textParts.length) {
        return;
      }

      const fullText = textParts.join(' ');

      // Create a new synthesis request with unique request ID
      const audioQueue = await this.#client.synthesize(fullText, this.#voiceSettings);
      const bstream = new AudioByteStream(sampleRate, DEFAULT_NUM_CHANNELS);

      let lastFrame: AudioFrame | undefined;

      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame && !this.queue.closed) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      let timeoutId: NodeJS.Timeout | null = null;
      const clearChunkTimeout = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      let hasReceivedData = false;

      try {
        // Set timeout for first chunk
        timeoutId = setTimeout(() => {
          if (!hasReceivedData && !audioQueue.closed) {
            this.#logger.warn(
              `No audio received after ${this.#chunkTimeout}ms in segment ${segmentId}`,
            );
            audioQueue.put(null);
            audioQueue.close();
          }
        }, this.#chunkTimeout);

        for await (const audioData of audioQueue) {
          if (this.abortController.signal.aborted) {
            break;
          }

          if (!hasReceivedData) {
            clearChunkTimeout();
            hasReceivedData = true;
          }

          if (audioData === null) {
            break;
          }

          const audioArray =
            audioData instanceof Buffer
              ? (audioData.buffer.slice(
                  audioData.byteOffset,
                  audioData.byteOffset + audioData.byteLength,
                ) as ArrayBuffer)
              : ((audioData as Uint8Array).buffer as ArrayBuffer);
          for (const frame of bstream.write(audioArray)) {
            sendLastFrame(segmentId, false);
            lastFrame = frame;
          }
        }
      } finally {
        clearChunkTimeout();
      }

      if (this.abortController.signal.aborted) {
        return;
      }

      // Flush remaining data
      for (const frame of bstream.flush()) {
        sendLastFrame(segmentId, false);
        lastFrame = frame;
      }

      // Send the last frame as final
      sendLastFrame(segmentId, true);

      // Signal end of stream for this segment
      if (!this.queue.closed) {
        this.queue.put(SynthesizeStream.END_OF_STREAM);
      }
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return;
      }

      this.#logger.error('Segment synthesis error:', error);
      throw new APIConnectionError({
        message: `Segment synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
