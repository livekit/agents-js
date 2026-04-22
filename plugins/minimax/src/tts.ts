// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  Future,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_VOICE_ID,
  type TTSEmotion,
  type TTSLanguageBoost,
  type TTSModel,
  type TTSSampleRate,
  type TTSVoice,
} from './models.js';

const NUM_CHANNELS = 1;
const DEFAULT_SAMPLE_RATE: TTSSampleRate = 24000;
const DEFAULT_BITRATE = 128000;

/** Configuration options for the MiniMax TTS plugin. */
export interface TTSOptions {
  /**
   * MiniMax model name. Defaults to `speech-02-turbo`.
   */
  model?: TTSModel | string;
  /**
   * MiniMax voice id. Defaults to {@link DEFAULT_VOICE_ID}.
   */
  voice?: TTSVoice | string;
  /**
   * Optional emotion override. `fluent` is only supported by `speech-2.6-*`
   * models; passing it with a different model throws at construction time.
   */
  emotion?: TTSEmotion;
  /** Playback speed. Must be in the range `[0.5, 2.0]`. */
  speed?: number;
  /** Volume. Must be in the range `(0, 10]`. */
  vol?: number;
  /** Pitch adjustment. Must be in the range `[-12, 12]`. */
  pitch?: number;
  /** Enable Chinese/English text normalization on the server side. */
  textNormalization?: boolean;
  /**
   * Pronunciation dictionary, in the format
   * `{ "word": ["replacement1", "replacement2"] }`.
   */
  pronunciationDict?: Record<string, string[]>;
  /** Voice strength slider. Range `[-100, 100]`. */
  intensity?: number;
  /** Voice timbre (nasal/crisp) slider. Range `[-100, 100]`. */
  timbre?: number;
  /** Language hint for multilingual performance. */
  languageBoost?: TTSLanguageBoost;
  /** Output PCM sample rate. Defaults to 24000. */
  sampleRate?: TTSSampleRate;
  /** Output bitrate (ignored for PCM). Kept for API parity. */
  bitrate?: number;
  /** API key. Falls back to `$MINIMAX_API_KEY`. */
  apiKey?: string;
  /**
   * Base URL of the MiniMax API. Falls back to `$MINIMAX_BASE_URL`, otherwise
   * {@link DEFAULT_BASE_URL}.
   */
  baseUrl?: string;
  /** Tokenizer used when chunking input text for the WebSocket stream. */
  tokenizer?: tokenize.SentenceTokenizer;
}

interface ResolvedTTSOptions {
  model: TTSModel | string;
  voice: TTSVoice | string;
  emotion?: TTSEmotion;
  speed: number;
  vol: number;
  pitch: number;
  textNormalization: boolean;
  pronunciationDict?: Record<string, string[]>;
  intensity?: number;
  timbre?: number;
  languageBoost?: TTSLanguageBoost;
  sampleRate: TTSSampleRate;
  bitrate: number;
  apiKey: string;
  baseUrl: string;
  tokenizer: tokenize.SentenceTokenizer;
}

const resolveOptions = (opts: TTSOptions): ResolvedTTSOptions => {
  const apiKey = opts.apiKey ?? process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error(
      'MiniMax API key is required, either as an argument or as $MINIMAX_API_KEY environment variable',
    );
  }

  const speed = opts.speed ?? 1.0;
  if (speed < 0.5 || speed > 2.0) {
    throw new Error(`speed must be between 0.5 and 2.0, but got ${speed}`);
  }
  if (opts.intensity !== undefined && (opts.intensity < -100 || opts.intensity > 100)) {
    throw new Error(`intensity must be between -100 and 100, but got ${opts.intensity}`);
  }
  if (opts.timbre !== undefined && (opts.timbre < -100 || opts.timbre > 100)) {
    throw new Error(`timbre must be between -100 and 100, but got ${opts.timbre}`);
  }

  const model = opts.model ?? DEFAULT_MODEL;
  if (opts.emotion === 'fluent' && !model.startsWith('speech-2.6')) {
    throw new Error(
      `"fluent" emotion is only supported by speech-2.6-* models, but got model "${model}". ` +
        'Please use speech-2.6-hd or speech-2.6-turbo.',
    );
  }

  return {
    model,
    voice: opts.voice ?? DEFAULT_VOICE_ID,
    emotion: opts.emotion,
    speed,
    vol: opts.vol ?? 1.0,
    pitch: opts.pitch ?? 0,
    textNormalization: opts.textNormalization ?? false,
    pronunciationDict: opts.pronunciationDict,
    intensity: opts.intensity,
    timbre: opts.timbre,
    languageBoost: opts.languageBoost,
    sampleRate: opts.sampleRate ?? DEFAULT_SAMPLE_RATE,
    bitrate: opts.bitrate ?? DEFAULT_BITRATE,
    apiKey,
    baseUrl: opts.baseUrl ?? process.env.MINIMAX_BASE_URL ?? DEFAULT_BASE_URL,
    tokenizer: opts.tokenizer ?? new tokenize.basic.SentenceTokenizer(),
  };
};

const toMiniMaxPayload = (opts: ResolvedTTSOptions): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    model: opts.model,
    voice_setting: {
      voice_id: opts.voice,
      speed: opts.speed,
      vol: opts.vol,
      pitch: opts.pitch,
      ...(opts.emotion !== undefined ? { emotion: opts.emotion } : {}),
    },
    audio_setting: {
      sample_rate: opts.sampleRate,
      bitrate: opts.bitrate,
      // The JS port only exposes PCM output because AudioByteStream expects
      // raw PCM samples; decoding mp3/flac on the fly would require an
      // external decoder and a matching pipeline in @livekit/agents.
      format: 'pcm',
      channel: 1,
    },
    text_normalization: opts.textNormalization,
  };

  if (opts.languageBoost !== undefined) {
    config.language_boost = opts.languageBoost;
  }

  if (opts.pronunciationDict) {
    config.pronunciation_dict = opts.pronunciationDict;
  }

  const voiceModify: Record<string, unknown> = {};
  if (opts.intensity !== undefined) voiceModify.intensity = opts.intensity;
  if (opts.timbre !== undefined) voiceModify.timbre = opts.timbre;
  if (Object.keys(voiceModify).length > 0) {
    config.voice_modify = voiceModify;
  }

  return config;
};

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  label = 'minimax.TTS';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'MiniMax';
  }

  constructor(opts: TTSOptions = {}) {
    const resolved = resolveOptions(opts);
    super(resolved.sampleRate, NUM_CHANNELS, {
      streaming: true,
      alignedTranscript: false,
    });
    this.#opts = resolved;
  }

  updateOptions(
    opts: Partial<
      Pick<
        TTSOptions,
        | 'model'
        | 'voice'
        | 'emotion'
        | 'speed'
        | 'vol'
        | 'pitch'
        | 'textNormalization'
        | 'pronunciationDict'
        | 'intensity'
        | 'timbre'
        | 'languageBoost'
      >
    >,
  ): void {
    this.#opts = {
      ...this.#opts,
      ...opts,
    };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SynthesizeStream(this, this.#opts, options?.connOptions);
  }
}

const hexToBuffer = (hex: string): Buffer => Buffer.from(hex, 'hex');

export class ChunkedStream extends tts.ChunkedStream {
  label = 'minimax.ChunkedStream';
  #logger = log();
  #opts: ResolvedTTSOptions;
  #text: string;

  constructor(
    tts: TTS,
    text: string,
    opts: ResolvedTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    if (!this.#text.trim()) {
      this.queue.close();
      return;
    }

    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

    const payload = toMiniMaxPayload(this.#opts);
    payload.text = this.#text;
    payload.stream = true;
    payload.stream_options = { exclude_aggregated_audio: true };

    const url = `${this.#opts.baseUrl}/v1/t2a_v2`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: this.abortSignal,
      });
    } catch (e) {
      if (this.abortSignal.aborted) return;
      const err = e as Error;
      if (err.name === 'AbortError') return;
      throw new APIConnectionError({ message: `MiniMax connection failed: ${err.message}` });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new APIStatusError({
        message: `MiniMax HTTP error: ${response.status} ${response.statusText}: ${body}`,
        options: { statusCode: response.status, requestId, body: body ? { raw: body } : null },
      });
    }

    const traceId =
      response.headers.get('Trace-Id') ?? response.headers.get('X-Trace-Id') ?? requestId;

    const reader = response.body?.getReader();
    if (!reader) {
      throw new APIError('MiniMax returned an empty response body');
    }

    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId: traceId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        // SSE frames are separated by '\n' (MiniMax uses a single newline, not \n\n).
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          if (!line.startsWith('data:')) {
            this.#logger.warn({ line }, 'unexpected MiniMax SSE line');
            continue;
          }

          const data = JSON.parse(line.slice(5).trim());

          const baseResp = data.base_resp ?? {};
          const statusCode = baseResp.status_code ?? 0;
          if (statusCode !== 0) {
            throw new APIStatusError({
              message: `MiniMax error [${statusCode}]: ${baseResp.status_msg ?? 'Unknown error'} (trace_id: ${data.trace_id ?? traceId})`,
              options: {
                statusCode,
                requestId: data.trace_id ?? traceId,
                body: data,
              },
            });
          }

          const audioHex = data?.data?.audio as string | undefined;
          if (audioHex) {
            const audio = hexToBuffer(audioHex);
            for (const frame of bstream.write(audio)) {
              sendLastFrame(traceId, false);
              lastFrame = frame;
            }
          }
        }
      }

      for (const frame of bstream.flush()) {
        sendLastFrame(traceId, false);
        lastFrame = frame;
      }
      sendLastFrame(traceId, true);
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (e instanceof APIError) throw e;
      const err = e as Error;
      if (err.name === 'AbortError') return;
      throw new APIConnectionError({ message: `MiniMax streaming failed: ${err.message}` });
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (!this.queue.closed) {
        this.queue.close();
      }
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'minimax.SynthesizeStream';
  #logger = log();
  #opts: ResolvedTTSOptions;
  #tokenStream: tokenize.SentenceStream;

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = opts;
    this.#tokenStream = opts.tokenizer.stream();
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    let currentTraceId = requestId;
    const taskStarted = new Future<void>();

    const wsUrl =
      (this.#opts.baseUrl.startsWith('http')
        ? this.#opts.baseUrl.replace(/^http/, 'ws')
        : this.#opts.baseUrl) + '/ws/v1/t2a_v2';

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.#opts.apiKey}` },
    });

    const inputTask = async () => {
      for await (const data of this.input) {
        if (this.abortController.signal.aborted) break;
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.#tokenStream.flush();
          continue;
        }
        this.#tokenStream.pushText(data);
      }
      this.#tokenStream.endInput();
    };

    const sendTask = async () => {
      const startMsg = toMiniMaxPayload(this.#opts);
      startMsg.event = 'task_start';
      ws.send(JSON.stringify(startMsg));

      try {
        await Promise.race([
          taskStarted.await,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new APITimeoutError({ message: 'task_start timed out' })),
              this.connOptions.timeoutMs,
            ),
          ),
        ]);
      } catch (e) {
        throw e;
      }

      for await (const sentence of this.#tokenStream) {
        if (this.abortController.signal.aborted) break;
        ws.send(JSON.stringify({ event: 'task_continue', text: sentence.token }));
      }

      ws.send(JSON.stringify({ event: 'task_finish' }));
    };

    const recvTask = async () => {
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
      let lastFrame: AudioFrame | undefined;
      let segmentId = requestId;

      const sendLastFrame = (final: boolean) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      for await (const rawMsg of iterateWebSocket(ws, this.abortController.signal)) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(rawMsg);
        } catch (e) {
          this.#logger.warn({ err: e, rawMsg }, 'failed to parse MiniMax WS message');
          continue;
        }

        const trace =
          (data.trace_id as string | undefined) ??
          ((data.base_resp as Record<string, unknown> | undefined)?.trace_id as string | undefined);
        if (trace) currentTraceId = trace;

        const baseResp = (data.base_resp as Record<string, unknown> | undefined) ?? {};
        const statusCode = (baseResp.status_code as number | undefined) ?? 0;
        if (statusCode !== 0) {
          throw new APIStatusError({
            message: `MiniMax error [${statusCode}]: ${baseResp.status_msg ?? 'Unknown error'} (trace_id: ${currentTraceId})`,
            options: { statusCode, requestId: currentTraceId, body: data },
          });
        }

        const event = data.event as string | undefined;
        if (event === 'connected_success') {
          continue;
        }
        if (event === 'task_started') {
          segmentId = (data.session_id as string | undefined) ?? requestId;
          if (!taskStarted.done) taskStarted.resolve();
          continue;
        }
        if (event === 'task_continued') {
          const audioHex = (data.data as { audio?: string } | undefined)?.audio;
          if (audioHex) {
            const audio = hexToBuffer(audioHex);
            for (const frame of bstream.write(audio)) {
              sendLastFrame(false);
              lastFrame = frame;
            }
          }
          if (data.is_final) {
            for (const frame of bstream.flush()) {
              sendLastFrame(false);
              lastFrame = frame;
            }
          }
          continue;
        }
        if (event === 'task_finished') {
          for (const frame of bstream.flush()) {
            sendLastFrame(false);
            lastFrame = frame;
          }
          sendLastFrame(true);
          this.queue.put(SynthesizeStream.END_OF_STREAM);
          break;
        }
        if (event === 'task_failed') {
          throw new APIError(
            `MiniMax task failed (trace_id: ${currentTraceId}): ${JSON.stringify(data)}`,
          );
        }
        this.#logger.warn({ data }, 'unexpected MiniMax WS event');
      }
    };

    try {
      await waitForWebSocketOpen(ws, this.connOptions.timeoutMs, this.abortController.signal);
      await Promise.all([inputTask(), sendTask(), recvTask()]);
    } catch (e) {
      if (this.abortController.signal.aborted) return;
      if (e instanceof APIError) throw e;
      const err = e as Error;
      throw new APIConnectionError({
        message: `MiniMax WebSocket connection failed: ${err.message} (trace_id: ${currentTraceId})`,
      });
    } finally {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore
      }
      this.#tokenStream.close();
    }
  }

  close(): void {
    this.#tokenStream.close();
    super.close();
  }
}

const waitForWebSocketOpen = async (
  ws: WebSocket,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) throw new Error('aborted');
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onClose);
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`WebSocket closed before open (code=${code}, reason=${reason.toString()})`));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            cleanup();
            reject(new APITimeoutError({ message: 'MiniMax WebSocket connect timeout' }));
          }, timeoutMs)
        : undefined;

    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

async function* iterateWebSocket(
  ws: WebSocket,
  signal: AbortSignal,
): AsyncGenerator<string, void, void> {
  const queue: string[] = [];
  let waiter: (() => void) | undefined;
  let closed = false;
  let error: Error | undefined;

  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w();
    }
  };

  ws.on('message', (data) => {
    queue.push(data.toString());
    wake();
  });
  ws.on('close', () => {
    closed = true;
    wake();
  });
  ws.on('error', (err) => {
    error = err;
    closed = true;
    wake();
  });
  signal.addEventListener(
    'abort',
    () => {
      closed = true;
      wake();
    },
    { once: true },
  );

  while (!closed || queue.length > 0) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (closed) break;
    await new Promise<void>((resolve) => {
      waiter = resolve;
    });
  }
  if (error) throw error;
}
