// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AudioByteStream,
  Future,
  log,
  shortuuid,
  type TimedString,
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
   * Ref: Python cartesia/tts.py line 98 - word_timestamps option
   * @default true
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
  // Ref: Python cartesia/tts.py line 98 - wordTimestamps defaults to true
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

    // Ref: Python cartesia/tts.py line 130-133 - set alignedTranscript based on wordTimestamps
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

    const sentenceStreamTask = async (ws: WebSocket) => {
      // Ref: Python cartesia/tts.py - use streaming: true to include add_timestamps
      const packet = toCartesiaOptions(this.#opts, true);
      for await (const event of this.#tokenizer) {
        ws.send(
          JSON.stringify({
            ...packet,
            context_id: requestId,
            transcript: event.token + ' ',
            continue: true,
          }),
        );
      }

      ws.send(
        JSON.stringify({
          ...packet,
          context_id: requestId,
          transcript: ' ',
          continue: false,
        }),
      );
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

    const recvTask = async (ws: WebSocket) => {
      let finalReceived = false;
      let shouldExit = false;
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

      let lastFrame: AudioFrame | undefined;
      // Ref: Python cartesia/tts.py line 490-492 - collect timed transcripts
      let pendingTimedTranscripts: TimedString[] = [];

      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame && !this.queue.closed) {
          // Include timedTranscripts with the audio frame
          // Ref: Python cartesia/tts.py line 490-492 - push_timed_transcript
          this.queue.put({
            requestId,
            segmentId,
            frame: lastFrame,
            final,
            timedTranscripts: pendingTimedTranscripts.length > 0 ? pendingTimedTranscripts : undefined,
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

      while (!this.closed && !this.abortController.signal.aborted && !shouldExit) {
        try {
          await new Promise<RawData | null>((resolve, reject) => {
            ws.removeAllListeners();
            ws.on('message', (data) => resolve(data));
            ws.on('close', (code, reason) => {
              if (!closing) {
                this.#logger.debug(`WebSocket closed with code ${code}: ${reason}`);
              }

              clearTTSChunkTimeout();
              if (!finalReceived) {
                reject(new Error('WebSocket closed'));
              } else {
                // If we've received the final message, resolve with empty to exit gracefully
                resolve(null);
              }
            });
          }).then((msg) => {
            if (!msg) return;

            const json = JSON.parse(msg.toString());
            const segmentId = json.context_id;

            // Ref: Python cartesia/tts.py line 456-492 - parse word_timestamps
            // Process word timestamps if present
            if (
              this.#opts.wordTimestamps !== false &&
              'word_timestamps' in json &&
              json.word_timestamps
            ) {
              const wordTimestamps = json.word_timestamps as {
                words: string[];
                start: number[];
                end: number[];
              };
              if (wordTimestamps.words && wordTimestamps.start && wordTimestamps.end) {
                for (let i = 0; i < wordTimestamps.words.length; i++) {
                  const word = wordTimestamps.words[i];
                  const startTime = wordTimestamps.start[i];
                  const endTime = wordTimestamps.end[i];
                  if (word !== undefined && startTime !== undefined && endTime !== undefined) {
                    pendingTimedTranscripts.push({
                      text: word + ' ', // Add space after word for consistency
                      startTime,
                      endTime,
                    });
                  }
                }
              }
            }

            if ('data' in json) {
              const data = new Int8Array(Buffer.from(json.data, 'base64'));
              for (const frame of bstream.write(data)) {
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
                  `Cartesia WebSocket STT chunk stream timeout after ${this.#opts.chunkTimeout}ms`,
                );
                ws.close();
              }, this.#opts.chunkTimeout);
            } else if ('done' in json) {
              finalReceived = true;
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
                shouldExit = true;
                clearTTSChunkTimeout();
                ws.close();
              }
            }
          });
        } catch (err) {
          // skip log error for normal websocket close
          if (err instanceof Error && !err.message.includes('WebSocket closed')) {
            if (err.message.includes('Queue is closed')) {
              this.#logger.warn(
                { err },
                'Queue closed during transcript processing (expected during disconnect)',
              );
            } else {
              this.#logger.error({ err }, 'Error in recvTask from Cartesia WebSocket');
            }
          }
          clearTTSChunkTimeout();
          break;
        }
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
 * Ref: Python cartesia/tts.py line 531-581 - _to_cartesia_options
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

  // Ref: Python cartesia/tts.py line 578-579 - add_timestamps for streaming
  if (streaming && opts.wordTimestamps !== false) {
    result.add_timestamps = true;
  }

  return result;
};
