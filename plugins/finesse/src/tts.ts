// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AsyncIterableQueue,
  AudioByteStream,
  ConnectionPool,
  DEFAULT_API_CONNECT_OPTIONS,
  Future,
  getBaseLanguage,
  log,
  normalizeLanguage,
  shortuuid,
  tts,
  waitForWebSocketOpen,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

const FINESSE_WS_URL = 'wss://fi.production.flamapis.com/flam-voice-svc/api/v1/public/stream';
const FINESSE_API_BASE = 'https://fi.production.flamapis.com/flam-voice-svc/api/v1/public';
const SUBPROTOCOL = 'finesse.v1';
const NUM_CHANNELS = 1;

// A direct session is minted with a generous character budget so a single call rarely exhausts
// it; the server clamps this to its own maximum. When a session does run out (or its ~1 hour TTL
// expires) the next synthesis mints a fresh one.
const SESSION_BUDGET_CHARS = 200_000;

/**
 * Finesse synthesizes at 24 kHz and upsamples above it. Below it, it produces only 8 kHz
 * telephony audio, so the rates it returns are 8000 and 24000 to 48000.
 */
const NATIVE_SAMPLE_RATE = 24000;
const TELEPHONY_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 48000;

// Text frames over 1 MiB close the socket. JSON.stringify keeps non-ASCII text as UTF-8, so a
// character costs at most 6 bytes (an escaped control character) and this stays far below it.
const MAX_TEXT_CHARS = 100_000;

// Finesse uses base ISO 639 codes, except where it names a macrolanguage member.
const LANGUAGE_OVERRIDES: Record<string, string> = { ar: 'arb', ne: 'npi', no: 'nb', or: 'ory' };
// Arabic regions with their own Finesse dialect: Egyptian, and Gulf (Khaleeji).
const ARABIC_REGIONS: Record<string, string> = {
  EG: 'arz',
  AE: 'afb',
  KW: 'afb',
  QA: 'afb',
  BH: 'afb',
  OM: 'afb',
};

// Finesse error codes are snake_case identifiers; anything else is not put in an error message.
const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;

// Error codes that fail the same way on retry.
const NON_RETRYABLE_CODES = new Set([
  'insufficient_credits',
  'quota_exhausted',
  'payment_required',
  'voice_not_found',
  'voice_not_allowed',
  'invalid_language',
  'invalid_request',
  'invalid_message',
  'text_required',
  'token_invalid',
  'key_expired',
  'insufficient_scope',
  'feature_disabled',
  'plan_limit_reached',
]);

// On a direct session these codes signal the session's own budget is spent (not the account's
// credits), so a freshly minted session continues; see eventError.
const SESSION_RENEWABLE_CODES = new Set(['insufficient_credits']);

// Close codes that fail the same way on a new connection: out of credits, frame too large.
// Any other close (normal, going away, service restart, engine failure) is retried.
const NON_RETRYABLE_CLOSE_CODES = new Set([1008, 1009]);

/** Options for the Finesse TTS. */
export interface TTSOptions {
  /** The id of a ready Finesse voice, one of your own (including cloned voices) or from the catalog. */
  voice: string;
  /** Finesse API key. Defaults to the `FINESSE_API_KEY` environment variable. */
  apiKey?: string;
  /** The language to speak, as a Finesse language code (for example `hi`, `ta` or `arz`). Defaults to `en`. */
  language?: string;
  /** Output sample rate in Hz: 8000 for telephony, or 24000 (native) up to 48000. Defaults to 24000. */
  sampleRate?: number;
  /** Quality vs latency, 1-32. Defaults to the server's 32. */
  numStep?: number;
  /** Synthesis guidance, 0-10. Defaults to the server's 2.0. */
  guidanceScale?: number;
  /** Speaking rate, greater than 0 up to 5; higher is slower. Defaults to the server's 1.0. */
  lengthScale?: number;
  /** Speak a pending partial sentence after this many milliseconds without new text, 200-5000. Defaults to the server's 800. */
  idleFlushMs?: number;
  /**
   * Connect straight to the synthesis GPU in your account's region over a short-lived,
   * voice-scoped session, instead of the relayed public stream. Lowers first-audio latency for
   * live agents. The session is minted for the current voice; changing the voice mints a new
   * one. Defaults to false.
   */
  useDirectSession?: boolean;
}

interface ResolvedTTSOptions {
  voice: string;
  apiKey: string;
  language: string;
  sampleRate: number;
  numStep?: number;
  guidanceScale?: number;
  lengthScale?: number;
  idleFlushMs?: number;
  useDirectSession: boolean;
}

type WebSocketEvent =
  | { type: 'message'; data: RawData; isBinary: boolean }
  | { type: 'close'; code: number }
  | { type: 'error'; error: Error }
  | { type: 'timeout' };

/**
 * Convert a language code or name to a Finesse language code.
 *
 * @param language - A language code (`hi`, `hi-IN`, `arz`) or name (`hindi`).
 * @returns The Finesse code, for example `ory` for Odia or `arz` for `ar-EG`.
 */
export function toFinesseLanguage(language: string): string {
  const normalized = normalizeLanguage(language);
  const base = getBaseLanguage(normalized);
  const region = normalized.split('-').find((part, i) => i > 0 && part.length === 2);
  if (base === 'ar' && region && ARABIC_REGIONS[region.toUpperCase()]) {
    return ARABIC_REGIONS[region.toUpperCase()]!;
  }
  return LANGUAGE_OVERRIDES[base] ?? base;
}

const validate = (opts: Partial<TTSOptions>): void => {
  if (opts.voice !== undefined && !opts.voice.trim()) {
    throw new Error('Finesse voice is required: pass the id of a ready voice');
  }
  if (
    opts.sampleRate !== undefined &&
    opts.sampleRate !== TELEPHONY_SAMPLE_RATE &&
    !(opts.sampleRate >= NATIVE_SAMPLE_RATE && opts.sampleRate <= MAX_SAMPLE_RATE)
  ) {
    throw new Error(
      `sampleRate must be ${TELEPHONY_SAMPLE_RATE}, or between ${NATIVE_SAMPLE_RATE} and ${MAX_SAMPLE_RATE} Hz`,
    );
  }
  if (opts.numStep !== undefined && !(opts.numStep >= 1 && opts.numStep <= 32)) {
    throw new Error('numStep must be between 1 and 32');
  }
  if (opts.guidanceScale !== undefined && !(opts.guidanceScale >= 0 && opts.guidanceScale <= 10)) {
    throw new Error('guidanceScale must be between 0 and 10');
  }
  if (opts.lengthScale !== undefined && !(opts.lengthScale > 0 && opts.lengthScale <= 5)) {
    throw new Error('lengthScale must be greater than 0 and at most 5');
  }
  if (opts.idleFlushMs !== undefined && !(opts.idleFlushMs >= 200 && opts.idleFlushMs <= 5000)) {
    throw new Error('idleFlushMs must be between 200 and 5000');
  }
};

/**
 * Finesse text-to-speech over the Finesse realtime WebSocket.
 *
 * Each synthesis is one Finesse context: text is sent as it arrives, and the audio comes back as
 * raw 16-bit PCM. Connections are pooled across syntheses.
 */
export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  #streams = new Set<SynthesizeStream>();
  // Aborted by close(): stops one-shot syntheses, which aren't tracked in #streams, and makes a
  // handshake that completes afterwards discard its socket.
  #closeController = new AbortController();
  /** Pooled Finesse connections. */
  pool: ConnectionPool<WebSocket>;
  label = 'finesse.TTS';
  /** @internal The realtime WebSocket URL; tests point it at a local server. */
  _wsUrl = FINESSE_WS_URL;
  /** @internal The direct-session mint base; tests point it at a local server. */
  _apiBase = FINESSE_API_BASE;

  /**
   * Create a Finesse TTS.
   *
   * @param opts - See {@link TTSOptions}. `voice` is required.
   */
  constructor(opts: TTSOptions) {
    validate(opts);
    const apiKey = opts.apiKey ?? process.env.FINESSE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Finesse API key is required, either as argument or set FINESSE_API_KEY environment variable',
      );
    }
    const sampleRate = opts.sampleRate ?? NATIVE_SAMPLE_RATE;

    super(sampleRate, NUM_CHANNELS, { streaming: true });

    this.#opts = {
      voice: opts.voice,
      apiKey,
      language: toFinesseLanguage(opts.language ?? 'en'),
      sampleRate,
      numStep: opts.numStep,
      guidanceScale: opts.guidanceScale,
      lengthScale: opts.lengthScale,
      idleFlushMs: opts.idleFlushMs,
      useDirectSession: opts.useDirectSession ?? false,
    };

    // Every setting travels in each context's task_start, so a settings change applies to the
    // next synthesis on a pooled connection without reconnecting.
    this.pool = new ConnectionPool<WebSocket>({
      connectCb: (timeout) => this.connectWs(timeout),
      closeCb: (ws) => this.closeWs(ws),
      // The server closes a session after 600 s without traffic.
      maxSessionDuration: 300_000,
      markRefreshedOnGet: true,
      connectTimeout: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
    });
  }

  get model(): string {
    return 'finesse';
  }

  get provider(): string {
    return 'Finesse';
  }

  /**
   * Update the TTS options. They apply from the next synthesis.
   *
   * @param opts - The options to change.
   */
  updateOptions(
    opts: Partial<
      Pick<TTSOptions, 'voice' | 'language' | 'numStep' | 'guidanceScale' | 'lengthScale'>
    >,
  ): void {
    validate(opts);
    if (opts.voice !== undefined && opts.voice !== this.#opts.voice) {
      this.#opts.voice = opts.voice;
      // A direct session is pinned to its voice, so drop pooled sessions; the next synthesis
      // mints one for the new voice.
      if (this.#opts.useDirectSession) this.pool.invalidate();
    }
    if (opts.language !== undefined) this.#opts.language = toFinesseLanguage(opts.language);
    if (opts.numStep !== undefined) this.#opts.numStep = opts.numStep;
    if (opts.guidanceScale !== undefined) this.#opts.guidanceScale = opts.guidanceScale;
    if (opts.lengthScale !== undefined) this.#opts.lengthScale = opts.lengthScale;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, connOptions, abortSignal);
  }

  /** @internal Aborted once the TTS is closed. */
  get _closeSignal(): AbortSignal {
    return this.#closeController.signal;
  }

  /** @internal The current options, copied so a later updateOptions() doesn't change them. */
  _options(): ResolvedTTSOptions {
    return { ...this.#opts };
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const stream = new SynthesizeStream(this, { ...this.#opts }, options?.connOptions);
    this.#streams.add(stream);
    return stream;
  }

  prewarm(): void {
    this.pool.prewarm();
  }

  /** Release pooled connections; an in-flight synthesis keeps its until it finishes. */
  override async releaseIdleConnections(): Promise<void> {
    await this.pool.releaseIdle();
  }

  /** @internal Called by a stream once it is done, so finished streams aren't kept. */
  _forgetStream(stream: SynthesizeStream): void {
    this.#streams.delete(stream);
  }

  async close(): Promise<void> {
    this.#closeController.abort();
    for (const stream of this.#streams) {
      stream.close();
    }
    this.#streams.clear();
    await this.pool.close();
  }

  /** @internal */
  async connectWs(timeout: number): Promise<WebSocket> {
    if (this.#opts.useDirectSession) return this.connectDirect(timeout);
    const ws = new WebSocket(this._wsUrl, [SUBPROTOCOL], {
      headers: {
        'X-API-Key': this.#opts.apiKey,
        'X-Finesse-Client': `livekit-agents-js/${__PACKAGE_VERSION__}`,
      },
      handshakeTimeout: timeout,
    });
    try {
      // A refused handshake reports only its status code, never the request headers.
      await waitForWebSocketOpen(ws, 'Finesse');
      if (this.#closeController.signal.aborted) {
        throw new APIConnectionError({
          message: 'Finesse TTS was closed',
          options: { retryable: false },
        });
      }
      // Between syntheses a pooled socket has no other listeners: the no-op error listener stops
      // an idle error from crashing the process, and a socket that closes while idle leaves the
      // pool so the next synthesis doesn't pick it up.
      ws.on('error', () => {});
      ws.on('close', () => this.pool.remove(ws));
      return ws;
    } catch (e) {
      try {
        ws.on('error', () => {});
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        } else {
          ws.terminate();
        }
      } catch {
        // ignore
      }
      if (e instanceof APIStatusError || e instanceof APIConnectionError) throw e;
      throw new APIConnectionError({
        message: `failed to connect to Finesse (${e instanceof Error ? e.name : typeof e})`,
      });
    }
  }

  /**
   * @internal Mint a direct realtime session and connect straight to the GPU region.
   *
   * The backend issues a short-lived, voice-scoped session token; the client then opens the
   * socket against the synthesis GPU itself, one hop closer than the relayed stream. The
   * per-turn protocol is identical.
   */
  async connectDirect(timeout: number): Promise<WebSocket> {
    const started = Date.now();
    const minted = await this.mintSession(timeout);
    const remaining = Math.max(0, timeout - (Date.now() - started));
    // The session token is the auth; it travels as the second subprotocol, not an API key.
    const ws = new WebSocket(minted.url, [SUBPROTOCOL, minted.token], {
      headers: { 'X-Finesse-Client': `livekit-agents-js/${__PACKAGE_VERSION__}` },
      handshakeTimeout: remaining,
    });
    try {
      await waitForWebSocketOpen(ws, 'Finesse');
      if (this.#closeController.signal.aborted) {
        throw new APIConnectionError({
          message: 'Finesse TTS was closed',
          options: { retryable: false },
        });
      }
      ws.on('error', () => {});
      ws.on('close', () => this.pool.remove(ws));
      return ws;
    } catch (e) {
      try {
        ws.on('error', () => {});
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        } else {
          ws.terminate();
        }
      } catch {
        // ignore
      }
      if (e instanceof APIStatusError || e instanceof APIConnectionError) throw e;
      throw new APIConnectionError({
        message: `failed to connect to Finesse (${e instanceof Error ? e.name : typeof e})`,
      });
    }
  }

  /** @internal Create a direct realtime session on the backend, returning the GPU URL and token. */
  async mintSession(timeout: number): Promise<{ url: string; token: string }> {
    let resp: Response;
    try {
      resp = await fetch(`${this._apiBase}/realtime/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.#opts.apiKey,
          'X-Finesse-Client': `livekit-agents-js/${__PACKAGE_VERSION__}`,
        },
        body: JSON.stringify({
          voice_ids: [this.#opts.voice],
          budget_chars: SESSION_BUDGET_CHARS,
        }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw new APIConnectionError({
        message: `failed to reach Finesse (${e instanceof Error ? e.name : typeof e})`,
      });
    }
    let payload: unknown;
    try {
      payload = await resp.json();
    } catch {
      payload = undefined;
    }
    const body = (payload ?? {}) as Record<string, unknown>;
    if (resp.status !== 200 && resp.status !== 201) {
      const code = identifier(body.code);
      throw new APIStatusError({
        message: `Finesse could not create a realtime session${code ? `: ${code}` : ''}`,
        options: { statusCode: resp.status, body },
      });
    }
    const data = body.data as Record<string, unknown> | undefined;
    const url = data?.url;
    const token = data?.token;
    if (typeof url !== 'string' || typeof token !== 'string') {
      throw new APIStatusError({
        message: 'Finesse returned an unexpected session response',
        options: { statusCode: resp.status, body },
      });
    }
    return { url, token };
  }

  /** @internal */
  async closeWs(ws: WebSocket): Promise<void> {
    ws.close();
  }
}

/** Synthesize a whole text as one Finesse context. */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'finesse.ChunkedStream';
  #logger = log();
  #tts: TTS;
  #opts: ResolvedTTSOptions;
  #text: string;
  #connOptions: APIConnectOptions;
  #callerSignal?: AbortSignal;

  constructor(tts: TTS, text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal) {
    super(text, tts, connOptions, abortSignal);
    this.#tts = tts;
    this.#opts = tts._options();
    this.#text = text;
    this.#connOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
    this.#callerSignal = abortSignal;
  }

  // One context, run here directly rather than through a SynthesizeStream: the base class's
  // retries, error reporting and usage metrics then apply once, to this stream.
  protected async run(): Promise<void> {
    const closed = this.#tts._closeSignal;
    // A signal that was already aborted never fires its listener, so check it here. A closed TTS
    // also starts no new attempt, so shutdown can't trigger a retry.
    if (this.abortSignal.aborted || this.#callerSignal?.aborted || closed.aborted) return;
    // Stop on the stream's own abort or when the TTS is closed: either ends the turn quietly.
    const stop = new AbortController();
    const onStop = () => stop.abort();
    this.abortSignal.addEventListener('abort', onStop, { once: true });
    closed.addEventListener('abort', onStop, { once: true });
    let emittedAudio = false;
    try {
      await runContext({
        tts: this.#tts,
        opts: this.#opts,
        timeoutMs: this.#connOptions.timeoutMs,
        abortSignal: stop.signal,
        pieces: [this.#text],
        inputEnded: () => true,
        waitForInput: async () => {},
        markStarted: () => {},
        put: (audio) => {
          this.queue.put(audio);
          emittedAudio = true;
        },
        logger: this.#logger,
      });
    } catch (e) {
      if (stop.signal.aborted) return;
      const error = toFinesseError(e);
      throw emittedAudio && error.retryable ? notRetryable(error) : error;
    } finally {
      this.abortSignal.removeEventListener('abort', onStop);
      closed.removeEventListener('abort', onStop);
    }
  }
}

/** Stream text into one Finesse context as it arrives. */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'finesse.SynthesizeStream';
  #logger = log();
  #tts: TTS;
  #opts: ResolvedTTSOptions;
  // The base class retries run() on the same stream, and its input queue can't be read twice,
  // so the input is read once into this buffer, which every attempt replays.
  #pieces: string[] = [];
  #inputEnded = false;
  #inputTask?: Promise<void>;
  #inputWaiters = new Set<() => void>();
  // Set once audio reached the listener: retrying after that would speak it twice.
  #emittedAudio = false;

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#tts = tts;
    this.#opts = opts;
  }

  protected override onStreamDone(): void {
    this.#tts._forgetStream(this);
  }

  protected async run(): Promise<void> {
    this.#inputTask ??= this.#readInput();
    try {
      await this.#attempt();
    } catch (e) {
      if (this.abortSignal.aborted) return;
      const error = toFinesseError(e);
      throw this.#emittedAudio && error.retryable ? notRetryable(error) : error;
    }

    if (!this.queue.closed) {
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    }
  }

  async #readInput(): Promise<void> {
    try {
      for await (const data of this.input) {
        // The server speaks a pending partial sentence on its own after idleFlushMs, so a
        // flush needs no message.
        if (data === SynthesizeStream.FLUSH_SENTINEL) continue;
        this.#pieces.push(data);
        this.#wakeInputWaiters();
      }
    } finally {
      this.#inputEnded = true;
      this.#wakeInputWaiters();
    }
  }

  #wakeInputWaiters(): void {
    for (const wake of this.#inputWaiters) wake();
    this.#inputWaiters.clear();
  }

  /** Wait until more input arrives, the input ends, or `signal` aborts. */
  #waitForInput(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        signal.removeEventListener('abort', wake);
        this.#inputWaiters.delete(wake);
        resolve();
      };
      this.#inputWaiters.add(wake);
      signal.addEventListener('abort', wake, { once: true });
    });
  }

  #attempt(): Promise<void> {
    return runContext({
      tts: this.#tts,
      opts: this.#opts,
      timeoutMs: this.connOptions.timeoutMs,
      abortSignal: this.abortSignal,
      pieces: this.#pieces,
      inputEnded: () => this.#inputEnded,
      waitForInput: (signal) => this.#waitForInput(signal),
      markStarted: () => this.markStarted(),
      put: (audio) => {
        this.queue.put(audio);
        this.#emittedAudio = true;
      },
      logger: this.#logger,
    });
  }
}

/** What one Finesse context needs from the stream that runs it. */
interface ContextHost {
  tts: TTS;
  opts: ResolvedTTSOptions;
  timeoutMs: number;
  abortSignal: AbortSignal;
  /** The text so far; it grows while the input is open. */
  pieces: readonly string[];
  inputEnded: () => boolean;
  /** Wait until more input arrives, the input ends, or `signal` aborts. */
  waitForInput: (signal: AbortSignal) => Promise<void>;
  /** Called once the first text goes to the server. */
  markStarted: () => void;
  put: (audio: tts.SynthesizedAudio) => void;
  logger: ReturnType<typeof log>;
}

/** Run one Finesse context on a pooled connection: send the text, emit its audio. */
async function runContext(host: ContextHost): Promise<void> {
  // Already aborted: don't connect or send anything.
  if (host.abortSignal.aborted) return;
  const contextId = shortuuid();
  const { opts } = host;
  const bstream = new AudioByteStream(opts.sampleRate, NUM_CHANNELS);
  let lastFrame: AudioFrame | undefined;

  const sendLastFrame = (final: boolean) => {
    if (lastFrame) {
      host.put({ requestId: contextId, segmentId: contextId, frame: lastFrame, final });
      lastFrame = undefined;
    }
  };

  await host.tts.pool.withConnection(
    async (ws) => {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new APIConnectionError({ message: 'Finesse connection closed while idle' });
      }

      const events = new AsyncIterableQueue<WebSocketEvent>();
      // Stops this attempt's sender when the receiver fails or the stream is aborted.
      const attempt = new AbortController();
      // Resolves true once the context is open, or false if the input ended without text.
      const opened = new Future<boolean>();
      let finished = false;
      let inputDone = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      // The timeout only runs once the input is finalized: while the LLM is still writing
      // (or calling a tool), the server can rightly have nothing to send.
      const armTimer = () => {
        if (timer) clearTimeout(timer);
        if (inputDone) {
          timer = setTimeout(() => events.put({ type: 'timeout' }), host.timeoutMs);
        }
      };

      const onMessage = (data: RawData, isBinary: boolean) =>
        events.put({ type: 'message', data, isBinary });
      const onClose = (code: number) => events.put({ type: 'close', code });
      const onError = (error: Error) => events.put({ type: 'error', error });
      // The user interrupted the agent: stop the server synthesizing the turn right away.
      const onAbort = () => {
        attempt.abort();
        if (opened.done && !finished) {
          try {
            ws.send(JSON.stringify({ type: 'task_cancel', context_id: contextId }));
          } catch {
            // the connection may already be gone, which stops the context too
          }
        }
      };

      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
      host.abortSignal.addEventListener('abort', onAbort, { once: true });
      if (host.abortSignal.aborted) onAbort();

      const sendTask = async () => {
        try {
          await sendInput();
        } finally {
          // Stopped before any text: let the receiver finish instead of waiting forever.
          if (!opened.done) opened.resolve(false);
        }
      };
      const sendInput = async () => {
        let isOpen = false;
        // Leading whitespace waits for real text: the server rejects a context with none.
        let pending = '';
        let next = 0;
        for (;;) {
          while (next < host.pieces.length) {
            if (attempt.signal.aborted) return;
            const data = host.pieces[next++]!;
            if (!isOpen) {
              pending += data;
              if (!pending.trim()) continue;
              host.markStarted();
              sendText(ws, opts, contextId, pending, { opened: false });
              isOpen = true;
              opened.resolve(true);
            } else {
              sendText(ws, opts, contextId, data, { opened: true });
            }
          }
          if (host.inputEnded()) break;
          await host.waitForInput(attempt.signal);
          if (attempt.signal.aborted) return;
        }
        if (isOpen) {
          sendText(ws, opts, contextId, '', { opened: true, finalize: true });
        }
        inputDone = true;
        armTimer();
        if (!opened.done) opened.resolve(false);
      };

      const recvTask = async () => {
        if (!(await opened.await)) return;
        // Each binary frame belongs to the context named by the audio_chunk just before it.
        let audioContext: string | undefined;
        for await (const event of events) {
          armTimer();
          if (event.type === 'timeout') {
            throw new APITimeoutError({ message: 'Finesse did not finish the turn in time' });
          }
          if (event.type === 'error') {
            throw new APIConnectionError({
              message: `Finesse WebSocket error (${event.error.name})`,
            });
          }
          if (event.type === 'close') {
            throw new APIStatusError({
              message: 'Finesse connection closed unexpectedly',
              options: {
                statusCode: event.code || -1,
                requestId: contextId,
                retryable: !NON_RETRYABLE_CLOSE_CODES.has(event.code),
              },
            });
          }

          if (event.isBinary) {
            if (audioContext === contextId) {
              for (const frame of bstream.write(toBuffer(event.data))) {
                sendLastFrame(false);
                lastFrame = frame;
              }
            }
            audioContext = undefined;
            continue;
          }

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(toBuffer(event.data).toString()) as Record<string, unknown>;
          } catch {
            host.logger.warn('Unexpected non-JSON Finesse message');
            continue;
          }
          const kind = data.type;
          const eventContext = data.context_id;

          if (kind === 'audio_chunk') {
            audioContext = typeof eventContext === 'string' ? eventContext : undefined;
          } else if (kind === 'error') {
            // A fatal error ends the session; a non-fatal one only rejected one message.
            if (data.fatal || eventContext === undefined || eventContext === contextId) {
              throw eventError(data, contextId, opts.useDirectSession);
            }
          } else if (kind === 'session_ended') {
            throw new APIStatusError({
              message: 'Finesse session ended',
              options: { requestId: contextId, body: { reason: identifier(data.reason) } },
            });
          } else if (eventContext !== contextId) {
            continue;
          } else if (kind === 'task_done') {
            for (const frame of bstream.flush()) {
              sendLastFrame(false);
              lastFrame = frame;
            }
            sendLastFrame(true);
            finished = true;
            return;
          } else if (kind === 'task_cancelled') {
            // The plugin only cancels a context it has stopped reading, so this came from the
            // server: the speech is incomplete.
            throw new APIStatusError({
              message: 'Finesse cancelled the context',
              options: { requestId: contextId },
            });
          } else if (kind === 'task_failed') {
            throw eventError(data, contextId, opts.useDirectSession);
          } else if (kind === 'task_started') {
            if (data.sample_rate !== undefined && data.sample_rate !== opts.sampleRate) {
              host.logger.warn(
                { requested: opts.sampleRate, returned: data.sample_rate },
                'Finesse returned a different sample rate',
              );
            }
          }
        }
      };

      // If either side fails, stop the other and wait for it, so a failed attempt's sender
      // can't keep running against a discarded socket.
      const stopOnFailure = (task: Promise<void>) =>
        task.catch((e: unknown) => {
          attempt.abort();
          throw e;
        });
      try {
        const results = await Promise.allSettled([
          stopOnFailure(recvTask()),
          stopOnFailure(sendTask()),
        ]);
        const failed = results.find((r) => r.status === 'rejected');
        if (failed) throw (failed as PromiseRejectedResult).reason;
      } finally {
        attempt.abort();
        if (timer) clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        host.abortSignal.removeEventListener('abort', onAbort);
        events.close();
      }
    },
    { timeout: host.timeoutMs, signal: host.abortSignal },
  );
}

/** Build the `task_start` frame that opens a context. */
const taskStart = (
  opts: ResolvedTTSOptions,
  contextId: string,
  text: string,
  finalize: boolean,
): Record<string, unknown> => {
  const msg: Record<string, unknown> = {
    type: 'task_start',
    context_id: contextId,
    voice_id: opts.voice,
    text,
    finalize,
    language: opts.language,
    output_format: 's16le',
    sample_rate: opts.sampleRate,
  };
  if (opts.numStep !== undefined) msg.num_step = opts.numStep;
  if (opts.guidanceScale !== undefined) msg.guidance_scale = opts.guidanceScale;
  if (opts.lengthScale !== undefined) msg.length_scale = opts.lengthScale;
  if (opts.idleFlushMs !== undefined) msg.idle_flush_ms = opts.idleFlushMs;
  return msg;
};

/** Send text to a context, opening it with task_start when it isn't open yet. */
const sendText = (
  ws: WebSocket,
  opts: ResolvedTTSOptions,
  contextId: string,
  text: string,
  { opened, finalize = false }: { opened: boolean; finalize?: boolean },
): void => {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + MAX_TEXT_CHARS, text.length);
    // Keep a surrogate pair (an emoji, say) in one frame.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(text.slice(i, end));
    i = end;
  }
  if (chunks.length === 0) chunks.push('');
  chunks.forEach((chunk, i) => {
    const last = finalize && i === chunks.length - 1;
    const msg =
      !opened && i === 0
        ? taskStart(opts, contextId, chunk, last)
        : { type: 'task_continue', context_id: contextId, text: chunk, finalize: last };
    ws.send(JSON.stringify(msg));
  });
};

const eventError = (
  data: Record<string, unknown>,
  requestId: string,
  direct = false,
): APIStatusError => {
  const code = identifier(data.code) ?? 'unknown_error';
  let retryable = !NON_RETRYABLE_CODES.has(code);
  if (direct && SESSION_RENEWABLE_CODES.has(code)) {
    // On a direct session this means the session's character budget is spent, not that the
    // account is out of credits: the next attempt mints a fresh session and continues. A truly
    // empty account instead fails when that mint is refused.
    retryable = true;
  }
  return new APIStatusError({
    message: `Finesse ${String(data.type)}: ${code}`,
    options: { requestId, body: { code }, retryable },
  });
};

/** A server-sent value, kept only if it is an identifier (so it can't carry speech). */
const identifier = (value: unknown): string | undefined =>
  typeof value === 'string' && ERROR_CODE_RE.test(value) ? value : undefined;

/** A thrown value as an APIStatusError or APIConnectionError. */
const toFinesseError = (e: unknown): APIStatusError | APIConnectionError =>
  e instanceof APIStatusError || e instanceof APIConnectionError
    ? e
    : new APIConnectionError({
        message: `Finesse TTS failed (${e instanceof Error ? e.name : typeof e})`,
      });

/** The same error, marked not retryable. */
const notRetryable = (
  error: APIStatusError | APIConnectionError,
): APIStatusError | APIConnectionError => {
  if (error instanceof APIStatusError) {
    return new APIStatusError({
      message: error.message,
      options: {
        statusCode: error.statusCode,
        requestId: error.requestId ?? undefined,
        body: error.body,
        retryable: false,
      },
    });
  }
  if (error instanceof APITimeoutError) {
    return new APITimeoutError({ message: error.message, options: { retryable: false } });
  }
  return new APIConnectionError({ message: error.message, options: { retryable: false } });
};

const toBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data as ArrayBuffer);
