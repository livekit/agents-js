// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
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
import type { DefaultLanguages, TTSModels } from './models.js';

const RIME_BASE_URL = 'https://users.rime.ai/v1/rime-tts';
const RIME_WS_BASE_URL = 'wss://users-ws.rime.ai';
const RIME_TTS_SAMPLE_RATE = 24000;
const RIME_TTS_CHANNELS = 1;

/**
 * Get the appropriate sample rate based on TTS options.
 *
 * @param opts - Optional TTS configuration options
 * @returns The sample rate in Hz. Returns the explicit samplingRate if provided,
 *          otherwise returns model-specific defaults (24000 for arcana, 16000 for mistv2,
 *          or the default RIME_TTS_SAMPLE_RATE for other models)
 */
function getSampleRate(opts?: Partial<TTSOptions>): number {
  if (opts?.samplingRate && typeof opts.samplingRate === 'number') {
    return opts.samplingRate;
  }
  switch (opts?.modelId) {
    case 'arcana':
    case 'coda':
      return 24000;
    case 'mistv2':
      return 16000;
    default:
      return RIME_TTS_SAMPLE_RATE;
  }
}

/** Configuration options for Rime AI TTS */
export interface TTSOptions {
  speaker: string;
  modelId: TTSModels | string;
  baseURL?: string;
  apiKey?: string;
  useWebsocket?: boolean;
  segment?: string;
  tokenizer?: tokenize.SentenceTokenizer;
  lang?: DefaultLanguages | string;
  repetition_penalty?: number;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  samplingRate?: number;
  timeScaleFactor?: number;
  speedAlpha?: number;
  reduceLatency?: boolean;
  pauseBetweenBrackets?: boolean;
  phonemizeBetweenBrackets?: boolean;
  inlineSpeedAlpha?: string;
  noTextNormalization?: boolean;
  saveOovs?: boolean;
  /** Additional Rime API parameters */
  [key: string]: string | number | boolean | tokenize.SentenceTokenizer | undefined;
}

const defaultTTSOptions: TTSOptions = {
  modelId: 'arcana',
  speaker: 'luna',
  apiKey: process.env.RIME_API_KEY,
  baseURL: RIME_BASE_URL,
  useWebsocket: false,
  segment: 'bySentence',
};

function modelParams(opts: TTSOptions): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  if (opts.lang !== undefined) params.lang = opts.lang;

  if (opts.modelId === 'arcana') {
    if (opts.repetition_penalty !== undefined) params.repetition_penalty = opts.repetition_penalty;
    if (opts.temperature !== undefined) params.temperature = opts.temperature;
    if (opts.top_p !== undefined) params.top_p = opts.top_p;
    if (opts.max_tokens !== undefined) params.max_tokens = opts.max_tokens;
    if (opts.timeScaleFactor !== undefined) params.timeScaleFactor = opts.timeScaleFactor;
  } else if (opts.modelId === 'coda') {
    if (opts.max_tokens !== undefined) params.max_tokens = opts.max_tokens;
    if (opts.timeScaleFactor !== undefined) params.timeScaleFactor = opts.timeScaleFactor;
  } else if (opts.modelId.includes('mist')) {
    if (opts.speedAlpha !== undefined) params.speedAlpha = opts.speedAlpha;
    if (opts.pauseBetweenBrackets !== undefined) {
      params.pauseBetweenBrackets = opts.pauseBetweenBrackets;
    }
    if (opts.phonemizeBetweenBrackets !== undefined) {
      params.phonemizeBetweenBrackets = opts.phonemizeBetweenBrackets;
    }
    if (opts.modelId !== 'mistv2' && opts.timeScaleFactor !== undefined) {
      params.timeScaleFactor = opts.timeScaleFactor;
    }
  }

  return params;
}

function fetchPayload(opts: TTSOptions, text: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    speaker: opts.speaker,
    text,
    modelId: opts.modelId,
    ...modelParams(opts),
  };

  if (opts.samplingRate !== undefined) payload.samplingRate = opts.samplingRate;
  if (opts.modelId === 'mistv2' && opts.reduceLatency !== undefined) {
    payload.reduceLatency = opts.reduceLatency;
  }

  for (const [key, value] of Object.entries(opts)) {
    if (
      value === undefined ||
      [
        'apiKey',
        'baseURL',
        'useWebsocket',
        'segment',
        'tokenizer',
        'speaker',
        'modelId',
        'lang',
        'repetition_penalty',
        'temperature',
        'top_p',
        'max_tokens',
        'samplingRate',
        'timeScaleFactor',
        'speedAlpha',
        'pauseBetweenBrackets',
        'phonemizeBetweenBrackets',
        'reduceLatency',
      ].includes(key)
    ) {
      continue;
    }
    payload[key] = value;
  }

  return payload;
}

function wsUrl(opts: TTSOptions): string {
  const params = new URLSearchParams();
  const sampleRate = getSampleRate(opts);
  const query: Record<string, string | number | boolean> = {
    speaker: opts.speaker,
    modelId: opts.modelId,
    audioFormat: 'pcm',
    samplingRate: sampleRate,
    segment: opts.segment ?? 'bySentence',
    ...modelParams(opts),
  };

  for (const [key, value] of Object.entries(query)) {
    params.set(key, typeof value === 'boolean' ? String(value) : `${value}`);
  }

  return `${opts.baseURL}/ws3?${params.toString()}`;
}

function resolveOptions(opts: Partial<TTSOptions>): TTSOptions {
  const useWebsocket = Boolean(
    opts.useWebsocket || opts.baseURL?.startsWith('ws://') || opts.baseURL?.startsWith('wss://'),
  );
  const resolved = {
    ...defaultTTSOptions,
    ...opts,
    useWebsocket,
    baseURL: opts.baseURL ?? (useWebsocket ? RIME_WS_BASE_URL : RIME_BASE_URL),
  };

  if (opts.speaker === undefined && opts.modelId === 'coda') {
    resolved.speaker = 'lyra';
  }

  if (resolved.modelId === 'mistv2' && resolved.timeScaleFactor !== undefined) {
    throw new Error(
      'timeScaleFactor is not supported by the mistv2 model; use arcana, mistv3, or coda.',
    );
  }

  return resolved;
}

export class TTS extends tts.TTS {
  private opts: TTSOptions;
  label = 'rime.TTS';

  /**
   * Create a new instance of Rime TTS.
   *
   * @remarks
   * `apiKey` must be set to your Rime AI API key, either using the argument or by setting the
   * `RIME_API_KEY` environmental variable.
   *
   * @param opts - Configuration options for the TTS instance
   */

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts = resolveOptions(opts);
    const sampleRate = getSampleRate(resolvedOpts);
    super(sampleRate, RIME_TTS_CHANNELS, {
      streaming: resolvedOpts.useWebsocket ?? false,
      alignedTranscript: resolvedOpts.useWebsocket ?? false,
    });

    this.opts = resolvedOpts;
    if (this.opts.apiKey === undefined) {
      throw new Error('RIME API key is required, whether as an argument or as $RIME_API_KEY');
    }
  }

  get model(): string {
    return this.opts.modelId;
  }

  get provider(): string {
    return 'Rime';
  }

  /**
   * Update TTS options after initialization
   *
   * @param opts - Partial options to update
   */
  updateOptions(opts: Partial<TTSOptions>) {
    this.opts = resolveOptions({ ...this.opts, ...opts });
  }

  /**
   * Synthesize text to audio using Rime AI TTS.
   *
   * @param text - Text to synthesize
   * @returns A chunked stream of synthesized audio
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    if (this.opts.useWebsocket) {
      throw new Error(
        'Rime TTS one-shot synthesize requires useWebsocket=false at construction time',
      );
    }
    return new ChunkedStream(this, text, { ...this.opts }, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    if (!this.opts.useWebsocket) {
      throw new Error('Rime TTS streaming requires useWebsocket=true at construction time');
    }
    return new SynthesizeStream(this, { ...this.opts }, options?.connOptions);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'rime-tts.ChunkedStream';
  private opts: TTSOptions;
  private text: string;

  /**
   * Create a new ChunkedStream instance.
   *
   * @param tts - The parent TTS instance
   * @param text - Text to synthesize
   * @param opts - TTS configuration options
   * @param connOptions - API connection options
   * @param abortSignal - Abort signal for cancellation
   */
  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.text = text;
    this.opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const response = await fetch(`${this.opts.baseURL}`, {
      method: 'POST',
      headers: {
        Accept: 'audio/pcm',
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...fetchPayload(this.opts, this.text),
      }),
      signal: this.abortSignal,
    });

    if (!response.ok) {
      throw new Error(`Rime AI TTS request failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Rime AI TTS response has no body');
    }

    const sampleRate = getSampleRate(this.opts);
    const audioByteStream = new AudioByteStream(sampleRate, RIME_TTS_CHANNELS);
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

        for (const frame of audioByteStream.write(value)) {
          sendLastFrame(requestId, false);
          lastFrame = frame;
        }
      }

      for (const frame of audioByteStream.flush()) {
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
  label = 'rime-tts.SynthesizeStream';
  #opts: TTSOptions;
  #logger = log();
  #tokenizer: tokenize.SentenceStream;

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = opts;
    this.#tokenizer = (opts.tokenizer ?? new tokenize.blingfire.SentenceTokenizer()).stream();
  }

  protected async run() {
    const requestId = shortuuid();
    const contextId = shortuuid();
    const bstream = new AudioByteStream(getSampleRate(this.#opts), RIME_TTS_CHANNELS);
    const messageChannel = stream.createStreamChannel<Record<string, unknown>>();
    const errorFuture = new Future<Error>();
    const inputSentFuture = new Future<void>();
    let emptyInput = false;
    let ws: WebSocket | undefined;

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

    const sendTask = async () => {
      let sentCount = 0;
      for await (const event of this.#tokenizer) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new APIConnectionError({ message: 'Rime WebSocket connection is closed' });
        }
        ws.send(JSON.stringify({ text: `${event.token} `, contextId }));
        if (!inputSentFuture.done) inputSentFuture.resolve();
        sentCount += 1;
      }

      if (sentCount === 0) {
        emptyInput = true;
        if (!inputSentFuture.done) inputSentFuture.resolve();
        return;
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new APIConnectionError({ message: 'Rime WebSocket connection is closed' });
      }
      ws.send(JSON.stringify({ operation: 'flush', contextId }));
    };

    const recvTask = async () => {
      await inputSentFuture.await;
      if (emptyInput) return;

      let lastFrame: AudioFrame | undefined;
      let pendingTimedTranscripts: TimedString[] = [];
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (!lastFrame || this.queue.closed) return;
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
      };

      const reader = messageChannel.stream().getReader();
      try {
        while (!this.closed && !this.abortSignal.aborted) {
          const [result, socketError] = await Promise.race([
            reader.read().then((result) => [result, undefined] as const),
            errorFuture.await.then((error) => [undefined, error] as const),
          ]);
          if (socketError) throw socketError;
          if (!result || result.done) break;

          const data = result.value;
          const type = data.type;
          if (type === 'chunk') {
            const audioBuffer = Buffer.from(data.data as string, 'base64');
            const audioData = audioBuffer.buffer.slice(
              audioBuffer.byteOffset,
              audioBuffer.byteOffset + audioBuffer.byteLength,
            );
            for (const frame of bstream.write(audioData)) {
              sendLastFrame(contextId, false);
              lastFrame = frame;
            }
          } else if (type === 'timestamps') {
            const wordTimestamps = data.word_timestamps as Record<string, unknown> | undefined;
            const words = wordTimestamps?.words as string[] | undefined;
            const starts = wordTimestamps?.start as number[] | undefined;
            const ends = wordTimestamps?.end as number[] | undefined;
            if (words && starts && ends) {
              const count = Math.min(words.length, starts.length, ends.length);
              for (let i = 0; i < count; i += 1) {
                pendingTimedTranscripts.push(
                  createTimedString({
                    text: `${words[i]} `,
                    startTime: starts[i]!,
                    endTime: ends[i]!,
                  }),
                );
              }
            }
          } else if (type === 'done') {
            for (const frame of bstream.flush()) {
              sendLastFrame(contextId, false);
              lastFrame = frame;
            }
            sendLastFrame(contextId, true);
            break;
          } else if (type === 'error') {
            throw new APIError(`Rime ws error: ${String(data.message ?? '(no message)')}`);
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    const onMessage = (rawData: RawData) => {
      try {
        void messageChannel.write(JSON.parse(rawData.toString()));
      } catch (error) {
        this.#logger.warn({ error }, 'failed to parse Rime WebSocket message');
      }
    };
    const onClose = (code: number, reason: Buffer) => {
      if (!this.abortSignal.aborted) {
        errorFuture.resolve(
          new APIStatusError({
            message: `Rime ws closed unexpectedly: ${reason.toString()}`,
            options: { statusCode: code },
          }),
        );
      }
      void messageChannel.close();
    };
    const onError = (error: Error) => {
      errorFuture.resolve(error);
      void messageChannel.close();
    };

    try {
      ws = await connectRimeWebSocket({
        url: wsUrl(this.#opts),
        apiKey: this.#opts.apiKey!,
        timeoutMs: this.connOptions.timeoutMs,
        abortSignal: this.abortSignal,
      });
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);

      await Promise.all([inputTask(), sendTask(), recvTask()]);
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) throw error;
      const err = asError(error);
      if (err.message.includes('timeout')) {
        throw new APITimeoutError({ message: `Rime WS error: ${err.message}` });
      }
      throw new APIConnectionError({ message: `Rime WS error: ${err.message}` });
    } finally {
      if (!inputSentFuture.done) inputSentFuture.resolve();
      void messageChannel.close();
      if (ws) {
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        closeRimeWebSocket(ws);
      }
    }
  }
}

async function connectRimeWebSocket({
  url,
  apiKey,
  timeoutMs,
  abortSignal,
}: {
  url: string;
  apiKey: string;
  timeoutMs: number;
  abortSignal: AbortSignal;
}): Promise<WebSocket> {
  if (abortSignal.aborted) throw new Error('aborted');
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: timeoutMs,
  });
  const fut = new Future<void>();
  let timeout: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    ws.off('open', onOpen);
    ws.off('error', onError);
    ws.off('close', onClose);
    abortSignal.removeEventListener('abort', onAbort);
  };
  const onOpen = () => fut.resolve();
  const onError = (error: Error) => fut.reject(error);
  const onClose = (code: number, reason: Buffer) =>
    fut.reject(
      new Error(`WebSocket closed before open (code=${code}, reason=${reason.toString()})`),
    );
  const onAbort = () => fut.reject(new Error('aborted'));

  ws.on('open', onOpen);
  ws.on('error', onError);
  ws.on('close', onClose);
  abortSignal.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs > 0)
    timeout = setTimeout(() => fut.reject(new Error('connect timeout')), timeoutMs);

  try {
    await fut.await;
    return ws;
  } catch (error) {
    closeRimeWebSocket(ws);
    throw error;
  } finally {
    cleanup();
  }
}

function closeRimeWebSocket(ws: WebSocket) {
  try {
    ws.on('error', () => {});
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ operation: 'eos' }));
      ws.close();
    } else if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  } catch {
    // best-effort close
  }
}
