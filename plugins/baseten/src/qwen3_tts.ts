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
  createTimedString,
  log,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { type RawData, WebSocket } from 'ws';
import { resolveEndpoint } from './endpoint.js';

export const QWEN3_SAMPLE_RATE = 24_000;
export const QWEN3_NUM_CHANNELS = 1;

const BYTES_PER_SECOND = QWEN3_SAMPLE_RATE * QWEN3_NUM_CHANNELS * 2;
const WS_MAX_PAYLOAD = 16 * 1024 * 1024;

// The server allows 10 seconds for session.config and 30 seconds between messages.
const UNCONFIGURED_TTL = 8_000;
const CONFIGURED_TTL = 25_000;
const KEEPALIVE_INTERVAL = 15_000;
const KEEPALIVE_TIMEOUT = 3_000;
const SESSION_DONE_TIMEOUT = 60_000;

export interface Qwen3TTSOptions {
  modelEndpoint?: string;
  modelId?: string;
  chainId?: string;
  apiKey?: string;
  voice: string;
  taskType?: string;
  language?: string | null;
  speed?: number;
  instructions?: string | null;
  maxNewTokens?: number | null;
  initialCodecChunkFrames?: number | null;
  xVectorOnlyMode?: boolean | null;
  refAudio?: string | null;
  refText?: string | null;
  wordTimestamps?: boolean;
  extraConfig?: Record<string, unknown>;
}

export interface ResolvedQwen3TTSOptions {
  voice: string;
  taskType: string;
  language: string | null;
  speed: number;
  instructions: string | null;
  maxNewTokens: number | null;
  initialCodecChunkFrames: number | null;
  xVectorOnlyMode: boolean | null;
  refAudio: string | null;
  refText: string | null;
  wordTimestamps: boolean;
  extraConfig: Record<string, unknown>;
}

export type Qwen3SessionConfig = Record<string, unknown>;

interface WarmSocket {
  ws: WebSocket;
  config: Qwen3SessionConfig | null;
  lastActivity: number;
}

type SocketEvent =
  | { type: 'binary'; data: Buffer }
  | { type: 'text'; data: string }
  | { type: 'close'; code: number; reason: string }
  | { type: 'error'; error: Error };

interface TurnState {
  flushesSent: number;
  flushesDone: number;
  senderFinished: boolean;
  progress: ProgressSignal;
}

class ProgressSignal {
  #version = 0;
  #waiters = new Set<() => void>();

  get version(): number {
    return this.#version;
  }

  pulse(): void {
    this.#version += 1;
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  wait(version: number, timeoutMs: number | undefined, signal?: AbortSignal): Promise<void> {
    if (this.#version !== version) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        this.#waiters.delete(onProgress);
        signal?.removeEventListener('abort', onAbort);
      };
      const onProgress = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('aborted'));
      };
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              cleanup();
              reject(new APITimeoutError({ message: 'Baseten TTS session timed out' }));
            }, timeoutMs);

      this.#waiters.add(onProgress);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

const isSettled = (state: TurnState): boolean =>
  state.senderFinished && state.flushesDone >= state.flushesSent;

/**
 * Connection state for a Qwen3-TTS deployment. A Baseten TTS instance owns one backend.
 * @internal
 */
export class Qwen3Backend {
  readonly modelEndpoint: string;
  #apiKey: string;
  #opts: ResolvedQwen3TTSOptions;
  #refAudioBase64: string | null = null;
  #warm: WarmSocket | null = null;
  #keepaliveTimer: NodeJS.Timeout | null = null;
  #keepaliveTask: Promise<void> | null = null;
  #keepaliveSocket: WebSocket | null = null;
  #active = new Set<WebSocket>();
  #closing = false;
  #logger = log();

  constructor(opts: Qwen3TTSOptions) {
    const apiKey = opts.apiKey ?? process.env.BASETEN_API_KEY;
    if (!apiKey) throw new Error('Pass `apiKey` or set BASETEN_API_KEY.');
    if (!opts.voice) {
      throw new Error('`voice` is required: the Base checkpoint has no presets.');
    }

    let speed = opts.speed ?? 1;
    if (speed !== 1) {
      this.#logger.warn({ speed }, 'progressive PCM requires speed=1.0; overriding');
      speed = 1;
    }

    this.#apiKey = apiKey;
    this.modelEndpoint = resolveEndpoint(
      opts.modelEndpoint,
      opts.modelId,
      opts.chainId,
      'BASETEN_MODEL_ENDPOINT',
    );
    this.#opts = {
      voice: opts.voice,
      taskType: opts.taskType ?? 'Base',
      language: opts.language === undefined ? 'Auto' : opts.language,
      speed,
      instructions: opts.instructions ?? null,
      maxNewTokens: opts.maxNewTokens ?? null,
      initialCodecChunkFrames: opts.initialCodecChunkFrames ?? null,
      xVectorOnlyMode: opts.xVectorOnlyMode ?? null,
      refAudio: opts.refAudio ?? null,
      refText: opts.refText ?? null,
      wordTimestamps: opts.wordTimestamps ?? false,
      extraConfig: { ...opts.extraConfig },
    };
  }

  get options(): Readonly<ResolvedQwen3TTSOptions> {
    return this.#opts;
  }

  updateOptions(
    opts: Partial<Pick<Qwen3TTSOptions, 'voice' | 'language' | 'instructions' | 'maxNewTokens'>>,
  ): void {
    if (opts.voice !== undefined) this.#opts.voice = opts.voice;
    if (opts.language !== undefined) this.#opts.language = opts.language;
    if (opts.instructions !== undefined) this.#opts.instructions = opts.instructions;
    if (opts.maxNewTokens !== undefined) this.#opts.maxNewTokens = opts.maxNewTokens;
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#keepaliveTimer) clearTimeout(this.#keepaliveTimer);
    this.#keepaliveTimer = null;

    // During an empty flush this is the only reference to the socket. Closing it
    // both wakes the flush and prevents cancellation from leaking the connection.
    const keepaliveSocket = this.#keepaliveSocket;
    this.#keepaliveSocket = null;
    if (keepaliveSocket) shutdownWebSocket(keepaliveSocket, false);
    await this.#keepaliveTask?.catch(() => {});

    for (const ws of this.#active) shutdownWebSocket(ws, false);
    this.#active.clear();

    const warm = this.#warm;
    this.#warm = null;
    if (warm) shutdownWebSocket(warm.ws, true);
  }

  async buildSessionConfig(): Promise<Qwen3SessionConfig> {
    const opts = this.#opts;
    const config: Qwen3SessionConfig = {
      task_type: opts.taskType,
      response_format: 'pcm',
      stream_audio: true,
      speed: opts.speed,
      voice: opts.voice,
    };
    const optional = {
      language: opts.language,
      instructions: opts.instructions,
      max_new_tokens: opts.maxNewTokens,
      initial_codec_chunk_frames: opts.initialCodecChunkFrames,
      x_vector_only_mode: opts.xVectorOnlyMode,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value !== null) config[key] = value;
    }

    const refAudio = await this.#loadRefAudio();
    if (refAudio) {
      config.ref_audio = refAudio;
      if (opts.refText) config.ref_text = opts.refText;
    }
    if (opts.wordTimestamps) {
      // Synchronous timestamps arrive in audio.done, where the sentence offset is exact.
      config.timestamp_type = 'word';
      config.timestamp_transport_strategy = 'sync';
    }
    return { ...config, ...opts.extraConfig };
  }

  async acquire(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<[WebSocket, Qwen3SessionConfig | null]> {
    if (this.#closing) {
      throw new APIConnectionError({
        message: 'Baseten Qwen3 TTS is closed',
        options: { retryable: false },
      });
    }
    // Taking the parked socket is deliberately synchronous. A turn never queues
    // behind the keepalive round trip; it dials another socket instead.
    const warm = this.#warm;
    this.#warm = null;
    if (warm) {
      const ttl = warm.config ? CONFIGURED_TTL : UNCONFIGURED_TTL;
      if (warm.ws.readyState === WebSocket.OPEN && Date.now() - warm.lastActivity < ttl) {
        this.#active.add(warm.ws);
        return [warm.ws, warm.config];
      }
      shutdownWebSocket(warm.ws, false);
    }

    const ws = await connectWebSocket({
      url: this.modelEndpoint,
      headers: { Authorization: `Api-Key ${this.#apiKey}` },
      timeoutMs,
      signal,
    });
    this.#active.add(ws);
    return [ws, null];
  }

  release(ws: WebSocket, config: Qwen3SessionConfig, discard: boolean): void {
    this.#active.delete(ws);
    if (discard || this.#closing || ws.readyState !== WebSocket.OPEN) {
      shutdownWebSocket(ws, !discard);
      return;
    }

    const stale = this.#warm;
    this.#warm = { ws, config, lastActivity: Date.now() };
    if (stale && stale.ws !== ws) shutdownWebSocket(stale.ws, true);
    this.#scheduleKeepalive();
  }

  #scheduleKeepalive(): void {
    if (this.#closing || this.#keepaliveTimer) return;
    this.#keepaliveTimer = setTimeout(() => {
      this.#keepaliveTimer = null;
      const task = this.#keepaliveLoop();
      this.#keepaliveTask = task;
      void task.finally(() => {
        if (this.#keepaliveTask === task) this.#keepaliveTask = null;
      });
    }, KEEPALIVE_INTERVAL);
  }

  async #keepaliveLoop(): Promise<void> {
    if (this.#closing) return;

    const warm = this.#warm;
    if (!warm?.config || warm.ws.readyState !== WebSocket.OPEN) {
      if (warm && warm.ws.readyState !== WebSocket.OPEN) this.#warm = null;
      this.#scheduleKeepalive();
      return;
    }

    this.#warm = null;
    this.#keepaliveSocket = warm.ws;
    let alive = false;
    try {
      alive = await emptyFlush(warm.ws, KEEPALIVE_TIMEOUT, this.#logger);
    } finally {
      this.#keepaliveSocket = null;
    }

    if (this.#closing) {
      shutdownWebSocket(warm.ws, false);
      return;
    }
    if (!alive) {
      shutdownWebSocket(warm.ws, false);
      this.#scheduleKeepalive();
      return;
    }

    warm.lastActivity = Date.now();
    if (this.#warm) {
      shutdownWebSocket(warm.ws, true);
    } else {
      this.#warm = warm;
    }
    // This loop intentionally lives until close, including after an empty park or failed flush.
    this.#scheduleKeepalive();
  }

  async #loadRefAudio(): Promise<string | null> {
    const ref = this.#opts.refAudio;
    if (!ref || ref.startsWith('http://') || ref.startsWith('https://')) return ref;
    if (this.#refAudioBase64 !== null) return this.#refAudioBase64;

    try {
      this.#refAudioBase64 = (await readFile(ref)).toString('base64');
      return this.#refAudioBase64;
    } catch (error) {
      this.#logger.error({ error, refAudio: ref }, 'refAudio is neither a URL nor a readable file');
      this.#opts.refAudio = null;
      return null;
    }
  }
}

/** One agent turn using Qwen3-TTS's session protocol. @internal */
export class Qwen3SynthesizeStream extends tts.SynthesizeStream {
  label = 'baseten.Qwen3SynthesizeStream';
  #backend: Qwen3Backend;
  #opts: ResolvedQwen3TTSOptions;
  #logger = log();
  #inputBuffer: Array<string | null> = [];
  #inputEnded = false;
  #inputSignal = new ProgressSignal();
  #inputPump?: Promise<void>;
  #audioPushed = false;
  #onDone: () => void;

  constructor(
    owner: tts.TTS,
    backend: Qwen3Backend,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    onDone: () => void = () => {},
  ) {
    super(owner, connOptions);
    this.#backend = backend;
    this.#opts = { ...backend.options, extraConfig: { ...backend.options.extraConfig } };
    this.#onDone = onDone;
  }

  protected override onStreamDone(): void {
    this.#onDone();
  }

  #startInputPump(): void {
    if (this.#inputPump) return;
    this.#inputPump = (async () => {
      for await (const data of this.input) {
        this.#inputBuffer.push(data === Qwen3SynthesizeStream.FLUSH_SENTINEL ? null : data);
        this.#inputSignal.pulse();
      }
      this.#inputEnded = true;
      this.#inputSignal.pulse();
    })();
  }

  protected async run(): Promise<void> {
    this.#startInputPump();
    const requestId = shortuuid();
    let ws: WebSocket;
    let appliedConfig: Qwen3SessionConfig | null;
    try {
      [ws, appliedConfig] = await this.#backend.acquire(
        this.connOptions.timeoutMs,
        this.abortSignal,
      );
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) throw error;
      throw connectionError(error);
    }

    const state: TurnState = {
      flushesSent: 0,
      flushesDone: 0,
      senderFinished: false,
      progress: new ProgressSignal(),
    };
    const inbox = socketInbox(ws);
    let byteStream = new AudioByteStream(QWEN3_SAMPLE_RATE, QWEN3_NUM_CHANNELS);
    let lastFrame: AudioFrame | undefined;
    let pendingTimedTranscripts: ReturnType<typeof createTimedString>[] = [];
    let segmentBytes = 0;
    let sentenceOffset = 0;
    let segmentId = shortuuid();
    let discard = true;
    const attemptController = new AbortController();

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame || this.queue.closed) return;
      this.queue.put({
        requestId,
        segmentId,
        frame: lastFrame,
        final,
        timedTranscripts: pendingTimedTranscripts.length > 0 ? pendingTimedTranscripts : undefined,
      });
      lastFrame = undefined;
      pendingTimedTranscripts = [];
    };

    const pushAudio = (data: Buffer) => {
      this.#audioPushed = true;
      segmentBytes += data.byteLength;
      for (const frame of byteStream.write(data)) {
        sendLastFrame(false);
        lastFrame = frame;
      }
      state.progress.pulse();
    };

    const sendTask = async () => {
      let buffered = false;
      let index = 0;
      const send = async (data: string | null) => {
        if (data === null) {
          if (!buffered) return;
          await sendJson(ws, { type: 'input.done' });
          state.flushesSent += 1;
          buffered = false;
          return;
        }
        this.markStarted();
        await sendJson(ws, { type: 'input.text', text: data });
        buffered = true;
      };

      try {
        while (true) {
          while (index < this.#inputBuffer.length) {
            await send(this.#inputBuffer[index++]!);
          }
          if (this.#inputEnded) break;
          const version = this.#inputSignal.version;
          await this.#inputSignal.wait(version, undefined, attemptController.signal);
        }
      } finally {
        state.senderFinished = true;
        state.progress.pulse();
      }
    };

    const recvTask = async () => {
      for await (const event of inbox.events) {
        if (event.type === 'binary') {
          pushAudio(event.data);
          continue;
        }
        if (event.type === 'close') {
          throw new APIConnectionError({
            message:
              `Baseten closed the TTS websocket ` + `(code=${event.code}, reason=${event.reason})`,
          });
        }
        if (event.type === 'error') throw connectionError(event.error);

        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          throw new APIConnectionError({ message: 'Baseten sent invalid TTS JSON', options: {} });
        }

        switch (message.type) {
          case 'audio.start': {
            const sampleRate = Number(message.sample_rate ?? QWEN3_SAMPLE_RATE);
            if (sampleRate !== QWEN3_SAMPLE_RATE) {
              this.#logger.warn(
                { sampleRate, expected: QWEN3_SAMPLE_RATE },
                'server sample rate differs; audio will be mistimed',
              );
            }
            sentenceOffset = segmentBytes / BYTES_PER_SECOND;
            break;
          }
          case 'audio.done':
            if (message.error) {
              this.#logger.error(
                { sentenceIndex: message.sentence_index },
                'synthesis failed for sentence',
              );
            } else if (this.#opts.wordTimestamps) {
              pendingTimedTranscripts.push(
                ...timedTranscripts(message.timestamp_info, sentenceOffset),
              );
            }
            break;
          case 'session.done':
            state.flushesDone += 1;
            state.progress.pulse();
            for (const frame of byteStream.flush()) {
              sendLastFrame(false);
              lastFrame = frame;
            }
            sendLastFrame(true);
            byteStream = new AudioByteStream(QWEN3_SAMPLE_RATE, QWEN3_NUM_CHANNELS);
            segmentBytes = 0;
            sentenceOffset = 0;
            segmentId = shortuuid();
            if (isSettled(state)) return;
            break;
          case 'error':
            throw new APIStatusError({
              message:
                typeof message.message === 'string' ? message.message : 'unknown Baseten TTS error',
              options: { statusCode: 500, requestId, body: message },
            });
        }
      }
      throw new APIConnectionError({ message: 'Baseten TTS websocket event stream ended' });
    };

    let receiverDone = false;
    const drainTask = async (receiver: Promise<void>) => {
      while (true) {
        if (receiverDone) {
          await receiver;
          return;
        }
        if (isSettled(state)) return;
        const version = state.progress.version;
        await state.progress.wait(version, SESSION_DONE_TIMEOUT, this.abortSignal);
      }
    };

    let sender: Promise<void> | undefined;
    let receiver: Promise<void> | undefined;
    let drain: Promise<void> | undefined;
    let config: Qwen3SessionConfig | undefined;
    try {
      config = await this.#backend.buildSessionConfig();
      if (!configsEqual(config, appliedConfig)) {
        await sendJson(ws, { type: 'session.config', ...config });
      }

      sender = sendTask();
      receiver = recvTask().then(
        () => {
          receiverDone = true;
          state.progress.pulse();
        },
        (error: unknown) => {
          receiverDone = true;
          state.progress.pulse();
          throw error;
        },
      );
      drain = drainTask(receiver);
      await Promise.all([sender, drain]);

      if (!this.queue.closed) this.queue.put(Qwen3SynthesizeStream.END_OF_STREAM);
      discard = false;
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (this.#audioPushed) {
        throw new APIConnectionError({
          message: error instanceof Error ? error.message : 'Baseten TTS stream failed',
          options: { retryable: false },
        });
      }
      if (error instanceof APIError) throw error;
      throw connectionError(error);
    } finally {
      attemptController.abort();
      inbox.close();
      // Discard before joining the tasks: closing the socket unblocks a send callback
      // or receiver that would otherwise keep this interrupted turn alive indefinitely.
      this.#backend.release(ws, config ?? {}, discard);
      await Promise.allSettled([sender, receiver, drain].filter((task) => task !== undefined));
    }
  }
}

export interface RegisterVoiceOptions {
  modelEndpoint: string;
  name: string;
  refAudioPath: string;
  refText?: string;
  apiKey?: string;
  consent?: string;
  timeoutMs?: number;
}

export async function registerVoice({
  modelEndpoint,
  name,
  refAudioPath,
  refText,
  apiKey,
  consent = 'user_consent',
  timeoutMs = DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
}: RegisterVoiceOptions): Promise<Record<string, unknown>> {
  const message: Record<string, unknown> = {
    type: 'voice.add',
    name,
    consent,
    audio_data: (await readFile(refAudioPath)).toString('base64'),
    audio_format: extname(refAudioPath).slice(1).toLowerCase() || 'wav',
  };
  if (refText) message.ref_text = refText;

  const response = await control(modelEndpoint, apiKey, message, timeoutMs);
  if (response.type === 'error' || !response.success) {
    throw new Error(`voice.add failed: ${String(response.message ?? JSON.stringify(response))}`);
  }
  return isRecord(response.voice) ? response.voice : response;
}

export interface ListVoicesOptions {
  modelEndpoint: string;
  apiKey?: string;
  timeoutMs?: number;
}

/** `voices` contains built-ins; `uploaded_voices` contains replica-local clones. */
export async function listVoices({
  modelEndpoint,
  apiKey,
  timeoutMs = DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
}: ListVoicesOptions): Promise<Record<string, unknown>> {
  const response = await control(modelEndpoint, apiKey, { type: 'voice.list' }, timeoutMs);
  if (response.type === 'error') {
    throw new Error(`voice.list failed: ${String(response.message ?? 'unknown error')}`);
  }
  return response;
}

async function control(
  modelEndpoint: string,
  suppliedApiKey: string | undefined,
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const apiKey = suppliedApiKey ?? process.env.BASETEN_API_KEY;
  if (!apiKey) throw new Error('Pass `apiKey` or set BASETEN_API_KEY.');

  const ws = await connectWebSocket({
    url: modelEndpoint,
    headers: { Authorization: `Api-Key ${apiKey}` },
    timeoutMs,
  });
  const inbox = socketInbox(ws);
  try {
    await sendJson(ws, message);
    const event = await nextWithTimeout(inbox.events, timeoutMs);
    if (event.type !== 'text') {
      throw new Error(`unexpected reply to ${JSON.stringify(message.type)}: ${event.type}`);
    }
    const response: unknown = JSON.parse(event.data);
    if (!isRecord(response)) throw new Error('Baseten control reply is not an object');
    return response;
  } finally {
    inbox.close();
    shutdownWebSocket(ws, false);
  }
}

function socketInbox(ws: WebSocket): {
  events: AsyncIterableQueue<SocketEvent>;
  close: () => void;
} {
  const events = new AsyncIterableQueue<SocketEvent>();
  const onMessage = (data: RawData, isBinary: boolean) => {
    if (events.closed) return;
    if (isBinary) {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      events.put({ type: 'binary', data: buffer });
    } else {
      events.put({ type: 'text', data: data.toString() });
    }
  };
  const onClose = (code: number, reason: Buffer) => {
    if (!events.closed) events.put({ type: 'close', code, reason: reason.toString() });
  };
  const onError = (error: Error) => {
    if (!events.closed) events.put({ type: 'error', error });
  };
  ws.on('message', onMessage);
  ws.on('close', onClose);
  ws.on('error', onError);

  return {
    events,
    close: () => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
      if (!events.closed) events.close();
    },
  };
}

async function emptyFlush(ws: WebSocket, timeoutMs: number, logger: ReturnType<typeof log>) {
  const inbox = socketInbox(ws);
  try {
    await sendJson(ws, { type: 'input.done' });
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const event = await nextWithTimeout(inbox.events, Math.max(1, deadline - Date.now()));
      if (event.type === 'binary') continue;
      if (event.type !== 'text') return false;
      const message: unknown = JSON.parse(event.data);
      if (!isRecord(message)) return false;
      if (message.type === 'session.done') return true;
      if (message.type === 'error') {
        logger.warn({ message: message.message }, 'Qwen3 keepalive rejected');
        return false;
      }
    }
  } catch (error) {
    logger.debug({ error }, 'Qwen3 keepalive failed; dropping socket');
    return false;
  } finally {
    inbox.close();
  }
}

async function nextWithTimeout<T>(queue: AsyncIterableQueue<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      queue.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new APITimeoutError({ message: 'Baseten websocket reply timed out' })),
          timeoutMs,
        );
      }),
    ]);
    if (result.done) throw new APIConnectionError({ message: 'Baseten websocket closed' });
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function timedTranscripts(value: unknown, offset: number) {
  if (!isRecord(value) || !isRecord(value.word_alignment)) return [];
  const alignment = value.word_alignment;
  const words = Array.isArray(alignment.words) ? alignment.words : [];
  const starts = Array.isArray(alignment.word_start_times_seconds)
    ? alignment.word_start_times_seconds
    : [];
  const ends = Array.isArray(alignment.word_end_times_seconds)
    ? alignment.word_end_times_seconds
    : [];
  const count = Math.min(words.length, starts.length, ends.length);
  const result: ReturnType<typeof createTimedString>[] = [];
  for (let i = 0; i < count; i += 1) {
    if (typeof words[i] !== 'string') continue;
    const start = Number(starts[i]);
    const end = Number(ends[i]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    result.push(
      createTimedString({
        text: `${words[i]} `,
        startTime: offset + start,
        endTime: offset + end,
      }),
    );
  }
  return result;
}

function configsEqual(left: Qwen3SessionConfig, right: Qwen3SessionConfig | null): boolean {
  return right !== null && JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function connectionError(error: unknown): APIConnectionError | APITimeoutError {
  if (error instanceof APITimeoutError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return new APITimeoutError({ message });
  return new APIConnectionError({ message: `Baseten TTS websocket failed: ${message}` });
}

function sendJson(ws: WebSocket, value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new APIConnectionError({ message: 'Baseten TTS websocket is not open' }));
      return;
    }
    ws.send(JSON.stringify(value), (error) => (error ? reject(error) : resolve()));
  });
}

function shutdownWebSocket(ws: WebSocket, notify: boolean): void {
  try {
    ws.on('error', () => {});
    if (notify && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'session.close' }), () => ws.close());
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    } else if (ws.readyState === WebSocket.OPEN) {
      ws.terminate();
    } else if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      ws.terminate();
    }
  } catch {
    // Teardown is best effort.
  }
}

async function connectWebSocket({
  url,
  headers,
  timeoutMs,
  signal,
}: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<WebSocket> {
  const ws = new WebSocket(url, {
    headers,
    handshakeTimeout: timeoutMs,
    maxPayload: WS_MAX_PAYLOAD,
    perMessageDeflate: false,
  });

  return await new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onClose);
      ws.off('unexpected-response', onUnexpectedResponse);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      cleanup();
      shutdownWebSocket(ws, false);
      reject(error);
    };
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (error: Error) => fail(error);
    const onClose = (code: number, reason: Buffer) =>
      fail(new Error(`websocket closed before open (code=${code}, reason=${reason.toString()})`));
    const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) =>
      fail(
        new APIStatusError({
          message: `Baseten websocket handshake failed with status ${response.statusCode ?? -1}`,
          options: { statusCode: response.statusCode },
        }),
      );
    const onAbort = () => fail(new Error('aborted'));

    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('close', onClose);
    ws.once('unexpected-response', onUnexpectedResponse);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new APITimeoutError({ message: 'Baseten websocket connect timed out' })),
        timeoutMs,
      );
    }
    if (signal?.aborted) onAbort();
  });
}
