// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AsyncIterableQueue,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  type TimedString,
  createTimedString,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { finished } from 'node:stream/promises';
import type { TTSModels } from './models.js';
import { SSEDecoder } from './sse.js';

const DEFAULT_BASE_URL = 'https://api.speechify.ai';
const DEFAULT_VOICE_ID = 'dominic_32';
const DEFAULT_MODEL: TTSModels = 'simba-3.2';
const STREAM_PATH = '/v1/audio/stream/with-timestamps';
// Unauthenticated, so warming the connection never sends the API key.
const PREWARM_PATH = '/health';
const PREWARM_TIMEOUT_MS = 10_000;
const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
// The first chunk of a response fills at least two 10 ms frames, so one plays at once while the
// other is held back to carry `final`.
const FRAME_SAMPLES = SAMPLE_RATE / 100;
// Long enough to keep the connection across the pause between turns, and well under the
// server's own idle timeout, so a pooled connection is never closed under a new request.
const IDLE_CONNECTION_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_LENGTH = 16_384;
const CALLER_HEADERS = {
  'Speechify-Caller': 'livekit',
  'Speechify-Caller-Version': __PACKAGE_VERSION__,
};

/** Options for the Speechify {@link TTS}. */
export interface TTSOptions {
  /** Speechify API key. Defaults to `$SPEECHIFY_API_KEY`. */
  apiKey?: string;
  /** Base URL of the Speechify API. */
  baseUrl: string;
  /** Voice to speak with. It must support {@link TTSOptions.model}; see `GET /v1/voices`. */
  voiceId: string;
  /** Synthesis model. */
  model: TTSModels | string;
  /** Language of the input as a BCP-47 tag, such as `en-US`. Defaults to the voice's locale. */
  language?: string;
  /** Normalize loudness to a standard level. Adds a little latency. */
  loudnessNormalization?: boolean;
  /** Expand numbers, dates and similar into words before synthesis. Adds a little latency. */
  textNormalization?: boolean;
  /** Splits the input of {@link TTS.stream} into sentences, which are synthesized one by one. */
  sentenceTokenizer: tokenize.SentenceTokenizer;
}

interface SpeechMark {
  value?: string;
  start?: number;
  end?: number;
  start_time?: number;
  end_time?: number;
}

interface SpeechChunk {
  audio?: Buffer;
  marks: SpeechMark[];
}

type AudioQueue = Pick<AsyncIterableQueue<tts.SynthesizedAudio>, 'closed' | 'put'>;

interface RequestContext {
  signal: AbortSignal;
  timeoutMs: number;
  onRequestId?: (requestId: string) => void;
}

// Lets each stream reach the client owned by the TTS that created it, without adding it to the
// stream constructors.
const clients = new WeakMap<TTS, SpeechifyClient>();

/**
 * Speechify text-to-speech over `POST /v1/audio/stream/with-timestamps`, which streams 24 kHz
 * mono PCM together with word-level speech marks.
 */
export class TTS extends tts.TTS {
  label = 'speechify.TTS';
  #opts: TTSOptions;
  #client: SpeechifyClient;

  /**
   * Create a new instance of Speechify TTS.
   *
   * @remarks
   * `apiKey` must be set to your Speechify API key, either using the argument or by setting the
   * `SPEECHIFY_API_KEY` environment variable.
   *
   * {@link TTS.stream} splits its input into sentences and synthesizes them one after another,
   * each as one streamed request, and {@link TTS.synthesize} streams its whole text in one
   * request. Requests share keep-alive connections, which {@link TTS.prewarm} opens ahead of the
   * first one. Word timestamps come with the audio.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true, alignedTranscript: true });

    const apiKey = opts.apiKey ?? process.env.SPEECHIFY_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Speechify API key is required, whether as an argument or as $SPEECHIFY_API_KEY',
      );
    }
    this.#opts = {
      baseUrl: DEFAULT_BASE_URL,
      voiceId: DEFAULT_VOICE_ID,
      model: DEFAULT_MODEL,
      sentenceTokenizer: new tokenize.basic.SentenceTokenizer(),
      ...opts,
      apiKey,
    };
    this.#client = new SpeechifyClient(this.#opts.baseUrl, apiKey);
    clients.set(this, this.#client);
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Speechify';
  }

  /** Update the synthesis options used by streams created from now on. */
  updateOptions(opts: Partial<Omit<TTSOptions, 'apiKey' | 'baseUrl'>>): void {
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

  /**
   * Open a connection to the Speechify API ahead of the first synthesis, so it does not pay for
   * DNS, TCP and TLS setup. Sends an unauthenticated `GET /health`.
   */
  prewarm(): void {
    this.#client.prewarm();
  }

  /** Close idle connections. A synthesis in flight keeps its connection until it finishes. */
  override async releaseIdleConnections(): Promise<void> {
    this.#client.releaseIdle();
  }

  override async close(): Promise<void> {
    this.#client.close();
    await super.close();
  }
}

/** One-shot synthesis of a whole text, streamed as it is generated. */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'speechify.ChunkedStream';
  #client: SpeechifyClient;
  #opts: TTSOptions;
  #timeoutMs: number;

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#client = clientOf(tts);
    this.#opts = opts;
    this.#timeoutMs = (connOptions ?? DEFAULT_API_CONNECT_OPTIONS).timeoutMs;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const emitter = new FrameEmitter(this.queue, requestId);
    const chunks = this.#client.synthesize(this.inputText, this.#opts, {
      signal: this.abortSignal,
      timeoutMs: this.#timeoutMs,
    });
    const aligner = new MarkAligner(this.inputText, '', 0);
    if (await emitter.play(chunks, aligner, requestId, this.abortSignal)) emitter.endSegment();
  }
}

type Work = { kind: 'sentence'; segmentId: string; text: string } | { kind: 'segmentEnd' };

/**
 * Streaming synthesis: the input is split into sentences, and each sentence is synthesized by one
 * streamed request as soon as it is complete. Every flush ends a segment.
 *
 * @remarks
 * The input is read once, into sentences that outlive a failed attempt, so a retry resumes at
 * the sentence that failed instead of finding the input already consumed. A sentence is only
 * retried when none of its audio has been received, so a retry never repeats speech that
 * already played.
 */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'speechify.SynthesizeStream';
  #client: SpeechifyClient;
  #opts: TTSOptions;
  #work = new AsyncIterableQueue<Work>();
  #readError?: unknown;
  #current?: Work;
  #emitter = new FrameEmitter(this.queue, shortuuid());
  #spoke = false;

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#client = clientOf(tts);
    this.#opts = opts;
    this.#readInput().catch((error: unknown) => {
      this.#readError = error;
    });
  }

  protected async run(): Promise<void> {
    while (!this.abortSignal.aborted) {
      if (!this.#current) {
        const next = await this.#work.next();
        if (next.done) break;
        this.#current = next.value;
      }
      if (this.#current.kind === 'segmentEnd') {
        this.#emitter.endSegment();
      } else if (!(await this.#synthesizeSentence(this.#current.text, this.#current.segmentId))) {
        return;
      }
      this.#current = undefined;
    }

    if (this.#readError !== undefined) throw this.#readError;
    if (!this.abortSignal.aborted && !this.queue.closed) {
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    }
  }

  async #readInput(): Promise<void> {
    try {
      let segmentId = shortuuid();
      let sentences = this.#opts.sentenceTokenizer.stream();
      let queued = this.#queueSentences(sentences, segmentId);
      for await (const data of this.input) {
        if (data !== SynthesizeStream.FLUSH_SENTINEL) {
          sentences.pushText(data);
          continue;
        }
        sentences.endInput();
        await queued;
        this.#work.put({ kind: 'segmentEnd' });

        segmentId = shortuuid();
        sentences = this.#opts.sentenceTokenizer.stream();
        queued = this.#queueSentences(sentences, segmentId);
      }
      sentences.endInput();
      await queued;
      this.#work.put({ kind: 'segmentEnd' });
    } finally {
      this.#work.close();
    }
  }

  async #queueSentences(sentences: tokenize.SentenceStream, segmentId: string): Promise<void> {
    for await (const { token } of sentences) {
      const text = token.trim();
      if (text) this.#work.put({ kind: 'sentence', segmentId, text });
    }
  }

  /** Returns false when the stream was closed during the sentence. */
  async #synthesizeSentence(text: string, segmentId: string): Promise<boolean> {
    const aligner = new MarkAligner(text, this.#spoke ? ' ' : '', this.#emitter.seconds);
    this.markStarted();
    const chunks = this.#client.synthesize(text, this.#opts, {
      signal: this.abortSignal,
      timeoutMs: this.connOptions.timeoutMs,
      onRequestId: (requestId) => this.noteProviderRequestId(requestId),
    });
    if (!(await this.#emitter.play(chunks, aligner, segmentId, this.abortSignal))) return false;
    this.#spoke = true;
    return true;
  }
}

const clientOf = (tts: TTS): SpeechifyClient => {
  const client = clients.get(tts);
  if (!client) throw new Error('Speechify TTS client is not initialized');
  return client;
};

/**
 * Cuts streamed PCM into frames and forwards them. The newest frame is held back until more
 * audio arrives, so the last frame of a segment can be sent with `final` set.
 */
class FrameEmitter {
  #queue: AudioQueue;
  #requestId: string;
  #held?: { frame: AudioFrame; segmentId: string };
  #timed: TimedString[] = [];
  #samples = 0;

  constructor(queue: AudioQueue, requestId: string) {
    this.#queue = queue;
    this.#requestId = requestId;
  }

  /** Duration of all the audio received so far, in seconds. */
  get seconds(): number {
    return this.#samples / SAMPLE_RATE;
  }

  /** Forwards one request's audio and timed text. Returns false if `signal` aborted it. */
  async play(
    chunks: AsyncIterable<SpeechChunk>,
    aligner: MarkAligner,
    segmentId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const bytes = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, FRAME_SAMPLES);
    const startSamples = this.#samples;
    const startTimed = this.#timed.length;
    try {
      for await (const { audio, marks } of chunks) {
        if (audio?.length) {
          this.#samples += audio.length / (2 * NUM_CHANNELS);
          this.#release();
          this.#hold(bytes.write(audio), segmentId);
        }
        this.#timed.push(...aligner.align(marks));
      }
    } catch (error) {
      if (signal.aborted) return false;
      const receivedAudio = this.#samples !== startSamples;
      if (!receivedAudio) this.#timed.length = startTimed;
      this.#release();
      // Retrying a request whose audio was already sent would speak that audio twice.
      if (receivedAudio && error instanceof APIError && error.retryable) throw notRetryable(error);
      throw error;
    }
    this.#hold(bytes.flush(), segmentId);
    this.#timed.push(...aligner.tail(this.seconds));
    return true;
  }

  endSegment() {
    this.#release(true);
  }

  #hold(frames: AudioFrame[], segmentId: string) {
    for (const frame of frames) {
      this.#release();
      this.#held = { frame, segmentId };
    }
  }

  #release(final = false) {
    if (!this.#held) return;
    if (!this.#queue.closed) {
      this.#queue.put({
        requestId: this.#requestId,
        segmentId: this.#held.segmentId,
        frame: this.#held.frame,
        final,
        timedTranscripts: this.#timed.length > 0 ? this.#timed : undefined,
      });
    }
    this.#held = undefined;
    this.#timed = [];
  }
}

/**
 * Turns the speech marks of one request into timed text. The marks address the request's input
 * by character offset, so each word takes the text since the previous word with it: the timed
 * strings then join back into the input, spaces and punctuation included.
 */
class MarkAligner {
  #text: string;
  #prefix: string;
  #offsetSeconds: number;
  #cursor = 0;
  #spoke = false;
  #lastEndSeconds: number;
  // SSML marks address the text inside the markup, not the input.
  #aligned: boolean;

  /** `prefix` goes before the first word, such as the space after the previous sentence. */
  constructor(text: string, prefix: string, offsetSeconds: number) {
    this.#text = text;
    this.#prefix = prefix;
    this.#offsetSeconds = offsetSeconds;
    this.#lastEndSeconds = offsetSeconds;
    this.#aligned = !text.trimStart().startsWith('<speak');
  }

  align(marks: SpeechMark[]): TimedString[] {
    const timed: TimedString[] = [];
    for (const mark of marks) {
      if (!mark.value || mark.start_time === undefined) continue;
      if (this.#aligned && !this.#addresses(mark)) {
        log().warn('Speechify speech marks do not address the input text; spacing words instead');
        this.#aligned = false;
      }
      let text: string;
      if (this.#aligned) {
        text = (this.#spoke ? '' : this.#prefix) + this.#text.slice(this.#cursor, mark.end);
        this.#cursor = mark.end!;
      } else {
        text = (this.#spoke ? ' ' : this.#prefix) + mark.value;
      }
      const startTime = this.#offsetSeconds + mark.start_time / 1000;
      const endTime =
        mark.end_time === undefined ? undefined : this.#offsetSeconds + mark.end_time / 1000;
      timed.push(createTimedString({ text, startTime, endTime }));
      this.#spoke = true;
      this.#lastEndSeconds = endTime ?? startTime;
    }
    return timed;
  }

  /** Text after the last word, such as a symbol that is not spoken, timed at `endSeconds`. */
  tail(endSeconds: number): TimedString[] {
    const rest =
      (this.#spoke ? '' : this.#prefix) + (this.#aligned ? this.#text.slice(this.#cursor) : '');
    if (!rest) return [];
    const time = Math.max(this.#lastEndSeconds, endSeconds);
    return [createTimedString({ text: rest, startTime: time, endTime: time })];
  }

  #addresses(mark: SpeechMark): boolean {
    const { start, end } = mark;
    return (
      start !== undefined &&
      end !== undefined &&
      start >= this.#cursor &&
      this.#text.slice(start, end) === mark.value
    );
  }
}

/** Owns the keep-alive connections that every request of one TTS shares. */
class SpeechifyClient {
  #baseUrl: string;
  #apiKey: string;
  #transport: typeof http | typeof https;
  #agent: http.Agent;
  #prewarm?: AbortController;

  constructor(baseUrl: string, apiKey: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.#transport = new URL(this.#baseUrl).protocol === 'http:' ? http : https;
    this.#agent = this.#newAgent();
  }

  /** Reads each response to its end, past `speech.done`, so its connection returns to the pool. */
  async *synthesize(
    text: string,
    opts: TTSOptions,
    { signal, timeoutMs, onRequestId }: RequestContext,
  ): AsyncGenerator<SpeechChunk> {
    const body = JSON.stringify(requestBody(text, opts));
    const req = this.#transport.request(`${this.#baseUrl}${STREAM_PATH}`, {
      method: 'POST',
      agent: this.#agent,
      signal,
      timeout: timeoutMs,
      headers: {
        ...CALLER_HEADERS,
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    let res: http.IncomingMessage | undefined;
    let timedOut = false;
    // A socket error is also reported on the request once the response has started; keep it
    // for its code, and so it never becomes an unhandled 'error' event.
    let socketError: unknown;
    req.on('error', (error) => {
      socketError ??= error;
    });
    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
    });

    try {
      req.end(body);
      [res] = (await once(req, 'response')) as [http.IncomingMessage];
      const requestId = header(res, 'speechify-request-id');
      if (requestId) onRequestId?.(requestId);
      if (res.statusCode !== 200) throw await statusError(res, requestId);

      res.setEncoding('utf8');
      const decoder = new SSEDecoder();
      let done = false;
      for await (const received of res as AsyncIterable<string>) {
        for (const data of decoder.push(received)) {
          const event = parseEvent(data);
          if (event.type === 'speech.chunk') {
            yield {
              audio:
                typeof event.audio === 'string' ? Buffer.from(event.audio, 'base64') : undefined,
              marks: Array.isArray(event.speech_marks) ? (event.speech_marks as SpeechMark[]) : [],
            };
          } else if (event.type === 'speech.done') {
            done = true;
          } else if (event.type === 'speech.error') {
            throw streamError(event, requestId);
          }
        }
      }
      if (!done) {
        throw new APIConnectionError({ message: 'Speechify stream ended before speech.done' });
      }
    } catch (error) {
      if (error instanceof APIError || signal.aborted) throw error;
      if (timedOut) throw new APITimeoutError({ message: 'Speechify request timed out' });
      throw connectionError(socketError ?? error);
    } finally {
      if (!res?.complete) req.destroy();
    }
  }

  prewarm(): void {
    if (this.#prewarm) return;
    const controller = new AbortController();
    this.#prewarm = controller;
    const req = this.#transport.request(`${this.#baseUrl}${PREWARM_PATH}`, {
      method: 'GET',
      agent: this.#agent,
      signal: controller.signal,
      timeout: PREWARM_TIMEOUT_MS,
      headers: CALLER_HEADERS,
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end();
    once(req, 'response')
      .then(([res]: http.IncomingMessage[]) => finished(res!.resume()))
      .catch((error: unknown) => log().debug({ error }, 'Speechify prewarm failed'))
      .finally(() => {
        if (this.#prewarm === controller) this.#prewarm = undefined;
      });
  }

  /** Closes idle connections; each one in use closes when its request finishes. */
  releaseIdle(): void {
    const retired = this.#agent;
    this.#agent = this.#newAgent();
    retired.on('free', (socket) => socket.destroy());
    for (const sockets of Object.values(retired.freeSockets)) {
      for (const socket of sockets ?? []) socket.destroy();
    }
  }

  close(): void {
    this.#prewarm?.abort();
    this.releaseIdle();
  }

  #newAgent(): http.Agent {
    return new this.#transport.Agent({ keepAlive: true, timeout: IDLE_CONNECTION_TIMEOUT_MS });
  }
}

const requestBody = (text: string, opts: TTSOptions) => ({
  input: text,
  voice_id: opts.voiceId,
  model: opts.model,
  language: opts.language,
  output_format: `pcm_${SAMPLE_RATE}`,
  options:
    opts.loudnessNormalization === undefined && opts.textNormalization === undefined
      ? undefined
      : {
          loudness_normalization: opts.loudnessNormalization,
          text_normalization: opts.textNormalization,
        },
});

const header = (res: http.IncomingMessage, name: string): string | undefined => {
  const value = res.headers[name];
  return typeof value === 'string' && value ? value : undefined;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const parseEvent = (data: string): Record<string, unknown> => {
  const event = parseJson(data);
  if (typeof event !== 'object' || event === null) {
    throw new APIConnectionError({ message: 'Speechify sent a malformed event' });
  }
  return event as Record<string, unknown>;
};

// Error messages carry only the status and Speechify's error code, never the input or the
// response body, because they end up in logs and traces.
const errorCode = (body: unknown): string | undefined => {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' && /^[a-z0-9_]+$/.test(code) ? code : undefined;
};

const statusError = async (
  res: http.IncomingMessage,
  requestId: string | undefined,
): Promise<APIStatusError> => {
  let body = '';
  res.setEncoding('utf8');
  // Read to the end so the connection can be reused.
  for await (const received of res as AsyncIterable<string>) {
    if (body.length < MAX_ERROR_BODY_LENGTH) body += received;
  }
  const code = errorCode(parseJson(body));
  const statusCode = res.statusCode ?? -1;
  return new APIStatusError({
    message: `Speechify request failed with status ${statusCode}${code ? ` (${code})` : ''}`,
    options: { statusCode, requestId },
  });
};

const streamError = (
  event: Record<string, unknown>,
  requestId: string | undefined,
): APIStatusError => {
  const code = errorCode(event);
  const eventRequestId = typeof event.request_id === 'string' ? event.request_id : undefined;
  return new APIStatusError({
    message: `Speechify synthesis failed${code ? ` (${code})` : ''}`,
    options: {
      requestId: eventRequestId ?? requestId,
      retryable: code !== 'content_policy_violation',
    },
  });
};

const connectionError = (error: unknown): APIConnectionError => {
  const code = (error as { code?: unknown } | null)?.code;
  const suffix = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : '';
  return new APIConnectionError({ message: `Speechify connection failed${suffix}` });
};

const notRetryable = (error: APIError): APIError => {
  const message = `${error.message}, after audio was already sent`;
  const options = { retryable: false };
  if (error instanceof APIStatusError) {
    return new APIStatusError({
      message,
      options: { ...options, statusCode: error.statusCode, requestId: error.requestId },
    });
  }
  if (error instanceof APITimeoutError) return new APITimeoutError({ message, options });
  if (error instanceof APIConnectionError) return new APIConnectionError({ message, options });
  return new APIError(message, options);
};
