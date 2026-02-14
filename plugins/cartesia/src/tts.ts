// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AudioByteStream,
  Future,
  type TimedString,
  createTimedString,
  log,
  shortuuid,
  stream,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { request } from 'node:https';
import { type RawData, WebSocket } from 'ws';
import {
  TTSDefaultVoiceId,
  type TTSEncoding,
  type TTSModels,
  type TTSVoiceEmotion,
  type TTSVoiceSpeed,
} from './models.js';
import {
  type CartesiaServerMessage,
  cartesiaMessageSchema,
  hasWordTimestamps,
  isChunkMessage,
  isDoneMessage,
  isErrorMessage,
} from './types.js';

const AUTHORIZATION_HEADER = 'X-API-Key';
const VERSION_HEADER = 'Cartesia-Version';
const VERSION = '2024-06-10';
const NUM_CHANNELS = 1;
const BUFFERED_WORDS_COUNT = 8;

export interface TTSOptions {
  model: TTSModels | string;
  encoding: TTSEncoding;
  sampleRate: number;
  voice: string | number[];
  speed?: TTSVoiceSpeed | number;
  emotion?: (TTSVoiceEmotion | string)[];
  apiKey?: string;
  language: string;
  baseUrl: string;

  /**
   * The timeout for the next chunk to be received from the Cartesia API.
   */
  chunkTimeout: number;

  /**
   * Whether to add word timestamps to the output. When enabled, the TTS will return
   * timing information for each word in the transcript.
   * @defaultValue true
   */
  wordTimestamps?: boolean;
}

const defaultTTSOptions: TTSOptions = {
  model: 'sonic-2',
  encoding: 'pcm_s16le',
  sampleRate: 24000,
  voice: TTSDefaultVoiceId,
  apiKey: process.env.CARTESIA_API_KEY,
  language: 'en',
  baseUrl: 'https://api.cartesia.ai',
  chunkTimeout: 5000,
  wordTimestamps: true,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'cartesia.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts = {
      ...defaultTTSOptions,
      ...opts,
    };

    super(resolvedOpts.sampleRate || defaultTTSOptions.sampleRate, NUM_CHANNELS, {
      streaming: true,
      alignedTranscript: resolvedOpts.wordTimestamps ?? true,
    });

    this.#opts = resolvedOpts;

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'Cartesia API key is required, whether as an argument or as $CARTESIA_API_KEY',
      );
    }

    if ((this.#opts.speed || this.#opts.emotion) && this.#opts.model !== 'sonic-2-2025-03-07') {
      const logger = log();
      logger.warn(
        { model: this.#opts.model, speed: this.#opts.speed, emotion: this.#opts.emotion },
        "speed and emotion controls are only supported for model 'sonic-2-2025-03-07', see https://docs.cartesia.ai/developer-tools/changelog for details",
      );
    }
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };

    if ((this.#opts.speed || this.#opts.emotion) && this.#opts.model !== 'sonic-2-2025-03-07') {
      const logger = log();
      logger.warn(
        { model: this.#opts.model, speed: this.#opts.speed, emotion: this.#opts.emotion },
        "speed and emotion controls are only supported for model 'sonic-2-2025-03-07', see https://docs.cartesia.ai/developer-tools/changelog for details",
      );
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): SynthesizeStream {
    return new SynthesizeStream(this, this.#opts);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'cartesia.ChunkedStream';
  #logger = log();
  #opts: TTSOptions;
  #text: string;

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const json = toCartesiaOptions(this.#opts);
    json.transcript = this.#text;

    const baseUrl = new URL(this.#opts.baseUrl);
    const doneFut = new Future<void>();

    const req = request(
      {
        hostname: baseUrl.hostname,
        port: parseInt(baseUrl.port) || (baseUrl.protocol === 'https:' ? 443 : 80),
        path: '/tts/bytes',
        method: 'POST',
        headers: {
          [AUTHORIZATION_HEADER]: this.#opts.apiKey!,
          [VERSION_HEADER]: VERSION,
        },
        signal: this.abortSignal,
      },
      (res) => {
        res.on('data', (chunk) => {
          for (const frame of bstream.write(chunk)) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
        });
        res.on('close', () => {
          for (const frame of bstream.flush()) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
          this.queue.close();
          doneFut.resolve();
        });
        res.on('error', (err) => {
          if (err.message === 'aborted') return;
          this.#logger.error({ err }, 'Cartesia TTS response error');
        });
      },
    );

    req.on('error', (err) => {
      if (err.name === 'AbortError') return;
      this.#logger.error({ err }, 'Cartesia TTS request error');
    });
    req.on('close', () => doneFut.resolve());
    req.write(JSON.stringify(json));
    req.end();

    await doneFut.await;
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  #tokenizer = new tokenize.basic.SentenceTokenizer({
    minSentenceLength: BUFFERED_WORDS_COUNT,
  }).stream();
  label = 'cartesia.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions) {
    super(tts);
    this.#opts = opts;
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };

    if ((this.#opts.speed || this.#opts.emotion) && this.#opts.model !== 'sonic-2-2025-03-07') {
      this.#logger.warn(
        { model: this.#opts.model, speed: this.#opts.speed, emotion: this.#opts.emotion },
        "speed and emotion controls are only supported for model 'sonic-2-2025-03-07', see https://docs.cartesia.ai/developer-tools/changelog for details",
      );
    }
  }

  protected async run() {
    const requestId = shortuuid();
    let closing = false;
    // Only close WebSocket when both: 1) Cartesia returns done, AND 2) all sentences have been sent
    let sentenceStreamClosed = false;

    const sentenceStreamTask = async (ws: WebSocket) => {
      const packet = toCartesiaOptions(this.#opts, true);
      for await (const event of this.#tokenizer) {
        const msg = {
          ...packet,
          context_id: requestId,
          transcript: event.token + ' ',
          continue: true,
        };
        ws.send(JSON.stringify(msg));
      }

      const endMsg = {
        ...packet,
        context_id: requestId,
        transcript: ' ',
        continue: false,
      };
      ws.send(JSON.stringify(endMsg));
      // Mark sentence stream as closed
      sentenceStreamClosed = true;
    };

    const inputTask = async () => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.#tokenizer.flush();
          continue;
        }
        this.#tokenizer.pushText(data);
      }
      this.#tokenizer.endInput();
      this.#tokenizer.close();
    };

    // Use event channel and set up listeners ONCE to avoid missing messages during listener re-registration
    const recvTask = async (ws: WebSocket) => {
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

      // Create event channel to buffer incoming messages
      // This prevents message loss between listener re-registrations
      const eventChannel = stream.createStreamChannel<RawData>();

      let lastFrame: AudioFrame | undefined;
      let pendingTimedTranscripts: TimedString[] = [];

      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame && !this.queue.closed) {
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

      let timeout: NodeJS.Timeout | null = null;

      const clearTTSChunkTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      // Set up WebSocket listeners ONCE (not in a loop)
      const onMessage = (data: RawData) => {
        void eventChannel.write(data).catch((error: unknown) => {
          this.#logger.debug({ error }, 'Failed writing Cartesia event to channel (likely closed)');
        });
      };

      const onClose = (code: number, reason: Buffer) => {
        if (!closing) {
          this.#logger.debug(`WebSocket closed with code ${code}: ${reason.toString()}`);
        }
        clearTTSChunkTimeout();
        void eventChannel.close();
      };

      const onError = (err: Error) => {
        this.#logger.error({ err }, 'Cartesia WebSocket error');
        void eventChannel.close();
      };

      // Attach listeners ONCE
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);

      try {
        // Process messages from the channel
        const reader = eventChannel.stream().getReader();

        while (!this.closed && !this.abortController.signal.aborted) {
          const result = await reader.read();
          if (result.done) break;

          const rawMsg = result.value;

          // Parse message with Zod schema for type safety
          let serverMsg: CartesiaServerMessage;
          try {
            const json = JSON.parse(rawMsg.toString());
            serverMsg = cartesiaMessageSchema.parse(json);
          } catch (parseErr) {
            this.#logger.warn({ parseErr }, 'Failed to parse Cartesia message');
            continue;
          }

          // Handle error messages
          if (isErrorMessage(serverMsg)) {
            this.#logger.error({ error: serverMsg.error }, 'Cartesia returned error');
            continue;
          }

          const segmentId = serverMsg.context_id;

          // Process word timestamps if present (typed via Zod schema)
          if (this.#opts.wordTimestamps !== false && hasWordTimestamps(serverMsg)) {
            const wordTimestamps = serverMsg.word_timestamps;
            for (let i = 0; i < wordTimestamps.words.length; i++) {
              const word = wordTimestamps.words[i];
              const startTime = wordTimestamps.start[i];
              const endTime = wordTimestamps.end[i];
              if (word !== undefined && startTime !== undefined && endTime !== undefined) {
                pendingTimedTranscripts.push(
                  createTimedString({
                    text: word + ' ', // Add space after word for consistency
                    startTime,
                    endTime,
                  }),
                );
              }
            }
          }

          // Handle audio chunk messages
          if (isChunkMessage(serverMsg)) {
            const audioBuffer = Buffer.from(serverMsg.data, 'base64');
            // Extract ArrayBuffer from Buffer for AudioByteStream compatibility
            const audioData = audioBuffer.buffer.slice(
              audioBuffer.byteOffset,
              audioBuffer.byteOffset + audioBuffer.byteLength,
            );
            for (const frame of bstream.write(audioData)) {
              sendLastFrame(segmentId, false);
              lastFrame = frame;
            }

            // IMPORTANT: close WS if TTS chunk stream been stuck too long
            // this allows unblock the current "broken" TTS node so that any future TTS nodes
            // can continue to process the stream without been blocked by the stuck node
            clearTTSChunkTimeout();
            timeout = setTimeout(() => {
              // cartesia chunk timeout quite often, so we make it a debug log
              this.#logger.debug(
                `Cartesia WebSocket TTS chunk stream timeout after ${this.#opts.chunkTimeout}ms`,
              );
              ws.close();
            }, this.#opts.chunkTimeout);
          } else if (isDoneMessage(serverMsg)) {
            // This ensures all sentences have been sent before closing
            if (sentenceStreamClosed) {
              for (const frame of bstream.flush()) {
                sendLastFrame(segmentId, false);
                lastFrame = frame;
              }
              sendLastFrame(segmentId, true);
              if (!this.queue.closed) {
                this.queue.put(SynthesizeStream.END_OF_STREAM);
              }

              if (segmentId === requestId) {
                closing = true;
                clearTTSChunkTimeout();
                ws.close();
                break; // Exit the loop
              }
            }
            // If sentenceStreamClosed is false, continue receiving - more done messages will come
          }
        }
      } catch (err) {
        // skip log error for normal websocket close
        if (err instanceof Error && !err.message.includes('WebSocket closed')) {
          if (
            err.message.includes('Queue is closed') ||
            err.message.includes('Channel is closed')
          ) {
            this.#logger.warn(
              { err },
              'Channel closed during transcript processing (expected during disconnect)',
            );
          } else {
            this.#logger.error({ err }, 'Error in recvTask from Cartesia WebSocket');
          }
        }
      } finally {
        // IMPORTANT: Remove listeners so connection can be reused
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        clearTTSChunkTimeout();
      }
    };

    const wsUrl = this.#opts.baseUrl.replace(/^http/, 'ws');
    const url = `${wsUrl}/tts/websocket?api_key=${this.#opts.apiKey}&cartesia_version=${VERSION}`;
    const ws = new WebSocket(url);

    try {
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', (error) => reject(error));
        ws.on('close', (code) => reject(`WebSocket returned ${code}`));
      });

      await Promise.all([inputTask(), sentenceStreamTask(ws), recvTask(ws)]);
    } catch (e) {
      throw new Error(`failed to connect to Cartesia: ${e}`);
    }
  }
}

/**
 * Convert TTSOptions to Cartesia API format.
 *
 * @param opts - TTS options
 * @param streaming - Whether this is for streaming (WebSocket) or non-streaming (HTTP)
 */
const toCartesiaOptions = (
  opts: TTSOptions,
  streaming: boolean = false,
): { [id: string]: unknown } => {
  const voice: { [id: string]: unknown } = {};
  if (typeof opts.voice === 'string') {
    voice.mode = 'id';
    voice.id = opts.voice;
  } else {
    voice.mode = 'embedding';
    voice.embedding = opts.voice;
  }

  const voiceControls: { [id: string]: unknown } = {};
  if (opts.speed) {
    voiceControls.speed = opts.speed;
  }
  if (opts.emotion) {
    voiceControls.emotion = opts.emotion;
  }

  if (Object.keys(voiceControls).length) {
    voice.__experimental_controls = voiceControls;
  }

  const result: { [id: string]: unknown } = {
    model_id: opts.model,
    voice,
    output_format: {
      container: 'raw',
      encoding: opts.encoding,
      sample_rate: opts.sampleRate,
    },
    language: opts.language,
  };

  if (streaming && opts.wordTimestamps !== false) {
    result.add_timestamps = true;
  }

  return result;
};
