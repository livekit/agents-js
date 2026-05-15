// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APITimeoutError,
  AudioByteStream,
  Future,
  type TimedString,
  asError,
  createTimedString,
  log,
  shortuuid,
  stream,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import { TTSDefaultVoiceId, type TTSModels, type TTSOutputFormat } from './models.js';
import {
  type GradiumServerMessage,
  gradiumServerMessageSchema,
  isAudioMessage,
  isEosMessage,
  isErrorMessage,
  isReadyMessage,
  isTextSegmentMessage,
} from './types.js';

const GRADIUM_API_KEY_HEADER = 'x-api-key';
const GRADIUM_SAMPLE_RATE = 48000;
const GRADIUM_CHANNELS = 1;
const BUFFERED_WORDS_COUNT = 8;

const sampleRateFromFormat = (format: TTSOutputFormat): number => {
  if (format === 'pcm') return GRADIUM_SAMPLE_RATE;
  const m = /^pcm_(\d+)$/.exec(format);
  return m ? parseInt(m[1]!, 10) : GRADIUM_SAMPLE_RATE;
};

/** Advanced voice generation settings */
export interface JsonConfig {
  /** Sampling temperature (0.0–1.4, default 0.7). Higher values produce more varied output. */
  temp?: number;
  /** Voice similarity coefficient (1.0–4.0, default 2.0). */
  cfg_coef?: number;
  /** Speech speed control (−4.0–4.0, default 0.0). Negative values are faster. */
  padding_bonus?: number;
  /** Language alias for text normalization rules (e.g. `"en"`, `"fr"`). */
  rewrite_rules?: string;
}

/** Configuration options for Gradium TTS */
export interface TTSOptions {
  /** Voice ID from the Gradium voice library or a custom cloned voice. */
  voiceId: string;
  /** TTS model name. */
  modelName: TTSModels | string;
  /**
   * Audio output format.
   * Must be a raw PCM variant (`"pcm"` or `"pcm_<rate>"`) when using the streaming voice pipeline,
   * since the framework feeds raw samples into `AudioByteStream`.
   * @defaultValue "pcm"
   */
  outputFormat: TTSOutputFormat;
  apiKey?: string;
  baseUrl: string;
  /** Optional pronunciation dictionary ID. */
  pronunciationId?: string;
  /**
   * Whether to include word-level timing in `SynthesizedAudio.timedTranscripts`.
   * @defaultValue true
   */
  wordTimestamps: boolean;
  /**
   * Milliseconds to wait for the next audio chunk before closing the WebSocket.
   * @defaultValue 5000
   */
  chunkTimeout: number;
  /** Advanced generation settings forwarded as `json_config`. */
  jsonConfig?: JsonConfig;
}

const defaultTTSOptions: TTSOptions = {
  voiceId: TTSDefaultVoiceId,
  modelName: 'default',
  outputFormat: 'pcm',
  apiKey: process.env.GRADIUM_API_KEY,
  baseUrl: 'https://api.gradium.ai/api',
  wordTimestamps: true,
  chunkTimeout: 5000,
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'gradium.TTS';

  get model(): string {
    return this.#opts.modelName;
  }

  get provider(): string {
    return 'Gradium';
  }

  /**
   * Create a new Gradium TTS instance.
   *
   * @remarks
   * `apiKey` must be set to your Gradium API key, either via the argument or the
   * `GRADIUM_API_KEY` environment variable.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts = { ...defaultTTSOptions, ...opts };
    super(sampleRateFromFormat(resolvedOpts.outputFormat), GRADIUM_CHANNELS, {
      streaming: true,
      alignedTranscript: resolvedOpts.wordTimestamps,
    });
    this.#opts = resolvedOpts;

    if (!this.#opts.apiKey) {
      throw new Error('Gradium API key is required, either as an argument or via $GRADIUM_API_KEY');
    }
  }

  /** Update options after construction. */
  updateOptions(opts: Partial<TTSOptions>): void {
    this.#opts = { ...this.#opts, ...opts };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SynthesizeStream(this, this.#opts, options?.connOptions);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'gradium.ChunkedStream';
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

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const sampleRate = sampleRateFromFormat(this.#opts.outputFormat);
    const bstream = new AudioByteStream(sampleRate, GRADIUM_CHANNELS);

    const body: Record<string, unknown> = {
      text: this.#text,
      voice_id: this.#opts.voiceId,
      output_format: this.#opts.outputFormat,
      only_audio: true,
      model_name: this.#opts.modelName,
    };
    if (this.#opts.pronunciationId) body.pronunciation_id = this.#opts.pronunciationId;
    if (this.#opts.jsonConfig) body.json_config = this.#opts.jsonConfig;

    let response: Response;
    try {
      response = await fetch(`${this.#opts.baseUrl}/post/speech/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [GRADIUM_API_KEY_HEADER]: this.#opts.apiKey!,
        },
        body: JSON.stringify(body),
        signal: this.abortSignal,
      });
    } catch (e) {
      if (this.abortSignal.aborted) return;
      this.queue.close();
      throw toRetryableConnectionError(e);
    }

    if (!response.ok) {
      throw new APIConnectionError({
        message: `Gradium TTS request failed: ${response.status} ${response.statusText}`,
      });
    }

    if (!response.body) {
      throw new APIConnectionError({ message: 'Gradium TTS response body is empty' });
    }

    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of bstream.write(value)) {
          sendLastFrame(requestId, false);
          lastFrame = frame;
        }
      }
      for (const frame of bstream.flush()) {
        if (frame.samplesPerChannel === 0) continue;
        sendLastFrame(requestId, false);
        lastFrame = frame;
      }
      sendLastFrame(requestId, true);
    } finally {
      reader.releaseLock();
      this.queue.close();
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #logger = log();
  #tokenizer = new tokenize.basic.SentenceTokenizer({
    minSentenceLength: BUFFERED_WORDS_COUNT,
  }).stream();
  label = 'gradium.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = opts;
  }

  /** Update options after construction. */
  updateOptions(opts: Partial<TTSOptions>): void {
    this.#opts = { ...this.#opts, ...opts };
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    // Resolved when the server confirms the setup message with a `ready` response.
    const readyFuture = new Future<void>();
    let closing = false;

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

    const sentenceTask = async (ws: WebSocket) => {
      // Wait for the server to confirm setup before sending text.
      await readyFuture.await;
      for await (const event of this.#tokenizer) {
        ws.send(
          JSON.stringify({ type: 'text', text: event.token + ' ', client_req_id: requestId }),
        );
      }
      ws.send(JSON.stringify({ type: 'end_of_stream', client_req_id: requestId }));
    };

    const recvTask = async (ws: WebSocket) => {
      const bstream = new AudioByteStream(
        sampleRateFromFormat(this.#opts.outputFormat),
        GRADIUM_CHANNELS,
      );
      const eventChannel = stream.createStreamChannel<RawData>();

      let lastFrame: AudioFrame | undefined;
      let pendingTimedTranscripts: TimedString[] = [];

      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame && !this.queue.closed) {
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

      let chunkTimeout: NodeJS.Timeout | null = null;
      const clearChunkTimeout = () => {
        if (chunkTimeout) {
          clearTimeout(chunkTimeout);
          chunkTimeout = null;
        }
      };

      const onMessage = (data: RawData) => {
        void eventChannel.write(data).catch((err: unknown) => {
          this.#logger.debug({ err }, 'Failed to write Gradium event to channel (likely closed)');
        });
      };
      const onClose = (code: number, reason: Buffer) => {
        if (!closing) {
          this.#logger.debug(`Gradium WebSocket closed: ${code} ${reason.toString()}`);
        }
        clearChunkTimeout();
        if (!readyFuture.done) {
          readyFuture.reject(new Error(`WebSocket closed before ready (code=${code})`));
        }
        void eventChannel.close();
      };
      const onError = (err: Error) => {
        this.#logger.error({ err }, 'Gradium WebSocket error');
        if (!readyFuture.done) {
          readyFuture.reject(err);
        }
        void eventChannel.close();
      };

      const onAbort = () => {
        if (!readyFuture.done) readyFuture.reject(new Error('aborted'));
        void eventChannel.close();
      };

      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const reader = eventChannel.stream().getReader();
        while (!this.closed && !this.abortController.signal.aborted) {
          const result = await reader.read();
          if (result.done) break;

          let serverMsg: GradiumServerMessage;
          try {
            serverMsg = gradiumServerMessageSchema.parse(JSON.parse(result.value.toString()));
          } catch (parseErr) {
            this.#logger.warn({ parseErr }, 'Failed to parse Gradium WebSocket message');
            continue;
          }

          if (isReadyMessage(serverMsg)) {
            if (!readyFuture.done) readyFuture.resolve();
            continue;
          }

          if (isErrorMessage(serverMsg)) {
            this.#logger.error(
              { message: serverMsg.message, code: serverMsg.code },
              'Gradium TTS error',
            );
            // Unblock sentenceTask if still waiting for ready.
            if (!readyFuture.done) readyFuture.reject(new Error(serverMsg.message));
            break;
          }

          if (isTextSegmentMessage(serverMsg) && this.#opts.wordTimestamps) {
            pendingTimedTranscripts.push(
              createTimedString({
                text: serverMsg.text,
                startTime: serverMsg.start_s ?? 0,
                endTime: serverMsg.stop_s ?? serverMsg.start_s ?? 0,
              }),
            );
            continue;
          }

          if (isAudioMessage(serverMsg)) {
            const buf = Buffer.from(serverMsg.data, 'base64');
            const audioData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            for (const frame of bstream.write(audioData)) {
              sendLastFrame(requestId, false);
              lastFrame = frame;
            }
            clearChunkTimeout();
            chunkTimeout = setTimeout(() => {
              this.#logger.debug(`Gradium chunk stream timeout after ${this.#opts.chunkTimeout}ms`);
              ws.close();
            }, this.#opts.chunkTimeout);
            continue;
          }

          if (isEosMessage(serverMsg)) {
            for (const frame of bstream.flush()) {
              sendLastFrame(requestId, false);
              lastFrame = frame;
            }
            sendLastFrame(requestId, true);
            if (!this.queue.closed) {
              this.queue.put(SynthesizeStream.END_OF_STREAM);
            }
            clearChunkTimeout();
            closing = true;
            ws.close();
            break;
          }
        }
      } catch (err) {
        if (err instanceof Error && !err.message.includes('WebSocket closed')) {
          if (
            err.message.includes('Queue is closed') ||
            err.message.includes('Channel is closed')
          ) {
            this.#logger.warn({ err }, 'Channel closed during processing (expected on disconnect)');
          } else {
            this.#logger.error({ err }, 'Error in recvTask from Gradium WebSocket');
          }
        }
      } finally {
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        this.abortController.signal.removeEventListener('abort', onAbort);
        clearChunkTimeout();
      }
    };

    // wss://api.gradium.ai/api/speech/tts
    const wsUrl = `${this.#opts.baseUrl.replace(/^http/, 'ws')}/speech/tts`;
    let ws: WebSocket | undefined;

    try {
      ws = await connectGradiumWebSocket({
        url: wsUrl,
        apiKey: this.#opts.apiKey!,
        timeoutMs: this.connOptions.timeoutMs,
        abortSignal: this.abortSignal,
      });

      // Send setup before starting tasks; recvTask will resolve readyFuture on `ready`.
      const setupMsg: Record<string, unknown> = {
        type: 'setup',
        voice_id: this.#opts.voiceId,
        output_format: this.#opts.outputFormat,
        model_name: this.#opts.modelName,
        close_ws_on_eos: true,
      };
      if (this.#opts.pronunciationId) setupMsg.pronunciation_id = this.#opts.pronunciationId;
      if (this.#opts.jsonConfig) setupMsg.json_config = this.#opts.jsonConfig;
      ws.send(JSON.stringify(setupMsg));

      await Promise.all([inputTask(), sentenceTask(ws), recvTask(ws)]);
    } catch (e) {
      if (this.abortSignal.aborted) return;
      throw toRetryableConnectionError(e);
    } finally {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        safeTerminateWebSocket(ws);
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const transientNetworkCodes = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ECONNREFUSED',
  'EHOSTUNREACH',
]);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

const isAggregateErrorLike = (e: unknown): e is { errors: unknown[]; name?: string } =>
  isRecord(e) && e.name === 'AggregateError' && Array.isArray(e.errors);

const hasAnyTransientCode = (e: unknown): boolean => {
  if (isRecord(e) && typeof e.code === 'string') return transientNetworkCodes.has(e.code);
  if (isAggregateErrorLike(e)) return e.errors.some((inner) => hasAnyTransientCode(inner));
  return false;
};

const toRetryableConnectionError = (e: unknown): APIConnectionError => {
  const err = asError(e);
  const isTimeout =
    (isRecord(e) && e.code === 'ETIMEDOUT') ||
    (typeof err.message === 'string' && err.message.includes('ETIMEDOUT'));
  const msg = isTimeout
    ? 'Gradium connection timed out'
    : `Gradium connection failed: ${err.message || 'unknown error'}`;
  return isTimeout
    ? new APITimeoutError({ message: msg })
    : new APIConnectionError({ message: msg });
};

const safeTerminateWebSocket = (ws: WebSocket): void => {
  try {
    ws.on('error', () => {});
  } catch {
    // ignore
  }
  try {
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    } else {
      ws.terminate();
    }
  } catch {
    // ignore
  }
};

const connectGradiumWebSocket = async ({
  url,
  apiKey,
  timeoutMs,
  abortSignal,
}: {
  url: string;
  apiKey: string;
  timeoutMs: number;
  abortSignal: AbortSignal;
}): Promise<WebSocket> => {
  const connectOnce = async (family?: number): Promise<WebSocket> => {
    const ws = new WebSocket(url, {
      handshakeTimeout: timeoutMs,
      family,
      headers: { [GRADIUM_API_KEY_HEADER]: apiKey },
    });

    if (abortSignal.aborted) {
      safeTerminateWebSocket(ws);
      throw new Error('aborted');
    }

    const fut = new Future<void>();
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onClose);
      abortSignal.removeEventListener('abort', onAbort);
    };

    const onOpen = () => {
      cleanup();
      fut.resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      fut.reject(asError(err));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      fut.reject(
        new Error(`WebSocket closed before open (code=${code}, reason=${reason.toString()})`),
      );
    };
    const onAbort = () => {
      cleanup();
      safeTerminateWebSocket(ws);
      fut.reject(new Error('aborted'));
    };

    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);
    abortSignal.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs > 0) {
      timeout = setTimeout(() => fut.reject(new Error('connect timeout')), timeoutMs);
    }

    try {
      await fut.await;
      return ws;
    } catch (e) {
      safeTerminateWebSocket(ws);
      throw e;
    }
  };

  try {
    return await connectOnce();
  } catch (e) {
    // One retry forcing IPv4 to work around Node.js dual-stack happy-eyeballs flakiness.
    if (hasAnyTransientCode(e) || isAggregateErrorLike(e)) {
      return await connectOnce(4);
    }
    throw e;
  }
};
