// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  normalizeLanguage,
  stt,
  waitForAbort,
  waitForWebSocketOpen,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import { PeriodicCollector } from './_utils.js';
import type {
  RealtimeEncoding,
  RealtimeEndpointing,
  RealtimeStreamType,
  STTModes,
  STTRealtimeLanguages,
  STTRealtimeModel,
} from './models.js';

const REALTIME_MODEL: STTRealtimeModel = 'saaras:v3-realtime';
const REALTIME_WS_URL = 'wss://api.sarvam.ai/speech-to-text-realtime/ws';
const AUDIO_CHUNK_MS = 50;
const NUM_CHANNELS = 1;
const USAGE_FLUSH_INTERVAL_S = 5;

const SUPPORTED_SAMPLE_RATES = new Set([8000, 16000]);
const SUPPORTED_STREAM_TYPES = new Set<RealtimeStreamType>(['fast', 'balanced', 'simulated']);
const SUPPORTED_ENDPOINTING = new Set<RealtimeEndpointing>(['vad', 'manual']);
const SUPPORTED_ENCODINGS = new Set<RealtimeEncoding>(['linear16', 'linear32', 'mulaw', 'alaw']);
const SUPPORTED_MODES = new Set<string>([
  'transcribe',
  'translate',
  'verbatim',
  'translit',
  'codemix',
]);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link STTRealtime}.
 *
 * @see {@link https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/realtime/ws | Sarvam realtime STT WebSocket docs}
 */
export interface STTRealtimeOptions {
  /** Sarvam API key. Defaults to $SARVAM_API_KEY */
  apiKey?: string;
  /** Language code (BCP-47), or 'auto' for adaptive language identification. Default: 'en-IN'. */
  language?: STTRealtimeLanguages | string;
  /** Latency profile for the stream. Default: 'balanced'. */
  streamType?: RealtimeStreamType;
  /** The task applied to final transcripts. Default: 'transcribe'. */
  mode?: STTModes | string;
  /** How turn boundaries are determined. Default: 'vad'. */
  endpointing?: RealtimeEndpointing;
  /** Wire audio encoding. Default: 'linear16'. */
  encoding?: RealtimeEncoding;
  /** Input audio sample rate. Must be 8000 or 16000. Default: 16000. */
  sampleRate?: number;
  /** Terminology or context hint used to bias decoding. */
  prompt?: string;
  /** Whether final transcripts include start/end timestamps. Default: false. */
  returnTimestamps?: boolean;
  /** Speech activation threshold (0.0-1.0). Applies only when `endpointing: 'vad'`. */
  vadSotThreshold?: number;
  /** Minimum speech duration (ms) before a turn opens. Applies only when `endpointing: 'vad'`. */
  vadMinSpeechMs?: number;
  /** End-of-turn silence duration (ms). Applies only when `endpointing: 'vad'`. */
  vadMinSilenceMs?: number;
  /**
   * Pre-speech padding (ms) included at the start of a turn. Applies only when
   * `endpointing: 'vad'`. Connection-time only — updates only affect newly created streams.
   */
  vadPrefixPaddingMs?: number;
}

interface ResolvedRealtimeOptions {
  apiKey: string;
  language: string;
  streamType: RealtimeStreamType;
  mode: string;
  endpointing: RealtimeEndpointing;
  encoding: RealtimeEncoding;
  sampleRate: number;
  prompt?: string;
  returnTimestamps: boolean;
  vadSotThreshold?: number;
  vadMinSpeechMs?: number;
  vadMinSilenceMs?: number;
  vadPrefixPaddingMs?: number;
}

function resolveRealtimeOptions(opts: Partial<STTRealtimeOptions>): ResolvedRealtimeOptions {
  const apiKey = opts.apiKey ?? process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error('Sarvam API key is required, whether as an argument or as $SARVAM_API_KEY');
  }

  const streamType = opts.streamType ?? 'balanced';
  if (!SUPPORTED_STREAM_TYPES.has(streamType)) {
    throw new Error(`unsupported Sarvam realtime STT streamType: ${streamType}`);
  }
  const mode = opts.mode ?? 'transcribe';
  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error(`unsupported Sarvam realtime STT mode: ${mode}`);
  }
  const endpointing = opts.endpointing ?? 'vad';
  if (!SUPPORTED_ENDPOINTING.has(endpointing)) {
    throw new Error(`unsupported Sarvam realtime STT endpointing: ${endpointing}`);
  }
  const encoding = opts.encoding ?? 'linear16';
  if (!SUPPORTED_ENCODINGS.has(encoding)) {
    throw new Error(`unsupported Sarvam realtime STT encoding: ${encoding}`);
  }
  const sampleRate = opts.sampleRate ?? 16000;
  if (!SUPPORTED_SAMPLE_RATES.has(sampleRate)) {
    throw new Error(
      `unsupported Sarvam realtime STT sampleRate: ${sampleRate} (must be 8000 or 16000)`,
    );
  }
  if (
    opts.vadSotThreshold !== undefined &&
    (opts.vadSotThreshold < 0 || opts.vadSotThreshold > 1)
  ) {
    throw new Error('vadSotThreshold must be between 0.0 and 1.0');
  }
  for (const [name, value] of [
    ['vadMinSpeechMs', opts.vadMinSpeechMs],
    ['vadMinSilenceMs', opts.vadMinSilenceMs],
    ['vadPrefixPaddingMs', opts.vadPrefixPaddingMs],
  ] as const) {
    if (value !== undefined && value < 0) {
      throw new Error(`${name} must be non-negative`);
    }
  }

  return {
    apiKey,
    language: normalizeLanguage(opts.language ?? 'en-IN'),
    streamType,
    mode,
    endpointing,
    encoding,
    sampleRate,
    prompt: opts.prompt,
    returnTimestamps: opts.returnTimestamps ?? false,
    vadSotThreshold: opts.vadSotThreshold,
    vadMinSpeechMs: opts.vadMinSpeechMs,
    vadMinSilenceMs: opts.vadMinSilenceMs,
    vadPrefixPaddingMs: opts.vadPrefixPaddingMs,
  };
}

function buildRealtimeWsUrl(opts: ResolvedRealtimeOptions): string {
  const params = new URLSearchParams();
  params.set('language_code', opts.language);
  params.set('stream_type', opts.streamType);
  params.set('endpointing', opts.endpointing);
  params.set('encoding', opts.encoding);
  params.set('sample_rate', String(opts.sampleRate));
  params.set('model', REALTIME_MODEL);
  params.set('mode', opts.mode);
  params.set('return_timestamps', String(opts.returnTimestamps));
  if (opts.prompt != null) {
    params.set('prompt', opts.prompt);
  }

  if (opts.endpointing === 'vad') {
    if (opts.vadSotThreshold != null) {
      params.set('threshold', String(opts.vadSotThreshold));
    }
    if (opts.vadMinSpeechMs != null) {
      params.set('min_speech_duration_ms', String(opts.vadMinSpeechMs));
    }
    if (opts.vadMinSilenceMs != null) {
      params.set('silence_duration_ms', String(opts.vadMinSilenceMs));
    }
    if (opts.vadPrefixPaddingMs != null) {
      params.set('prefix_padding_ms', String(opts.vadPrefixPaddingMs));
    }
  }

  return `${REALTIME_WS_URL}?${params.toString()}`;
}

function buildConfigUpdatePayload(
  previous: ResolvedRealtimeOptions,
  current: ResolvedRealtimeOptions,
): Record<string, unknown> | null {
  const payload: Record<string, unknown> = { event: 'config.update' };
  const entries: [string, unknown, unknown][] = [
    ['language_code', previous.language, current.language],
    ['stream_type', previous.streamType, current.streamType],
    ['mode', previous.mode, current.mode],
    ['prompt', previous.prompt, current.prompt],
    ['endpointing', previous.endpointing, current.endpointing],
    ['threshold', previous.vadSotThreshold, current.vadSotThreshold],
    ['min_speech_duration_ms', previous.vadMinSpeechMs, current.vadMinSpeechMs],
    ['silence_duration_ms', previous.vadMinSilenceMs, current.vadMinSilenceMs],
  ];
  for (const [key, oldValue, newValue] of entries) {
    if (oldValue !== newValue) {
      payload[key] = key === 'prompt' && newValue == null ? '' : newValue;
    }
  }
  return Object.keys(payload).length > 1 ? payload : null;
}

// ---------------------------------------------------------------------------
// PCM wire encoders
// ---------------------------------------------------------------------------

// Faithful port of the standard ITU-T G.711 reference encoders (the same `linear2ulaw`/
// `linear2alaw` algorithm — segment tables, bit-exact shifts and masks — found in Sun's
// canonical g711.c and used by virtually every G.711 implementation since).
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 8159;
const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

function search(val: number, table: number[]): number {
  for (let i = 0; i < table.length; i++) {
    if (val <= table[i]!) return i;
  }
  return table.length;
}

function linearToMulaw(sample: number): number {
  let pcm = sample >> 2;
  let mask: number;
  if (pcm < 0) {
    pcm = -pcm;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }
  if (pcm > MULAW_CLIP) pcm = MULAW_CLIP;
  pcm += MULAW_BIAS >> 2;

  const seg = search(pcm, SEG_UEND);
  if (seg >= 8) return 0x7f ^ mask;
  const uval = (seg << 4) | ((pcm >> (seg + 1)) & 0x0f);
  return (uval ^ mask) & 0xff;
}

function linearToAlaw(sample: number): number {
  let pcm = sample >> 3;
  let mask: number;
  if (pcm >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    pcm = -pcm - 1;
  }

  const seg = search(pcm, SEG_AEND);
  if (seg >= 8) return (0x7f ^ mask) & 0xff;
  let aval = seg << 4;
  aval |= seg < 2 ? (pcm >> 1) & 0x0f : (pcm >> seg) & 0x0f;
  return (aval ^ mask) & 0xff;
}

/** @internal exported only for unit tests */
export function encodePcmForWire(encoding: RealtimeEncoding, frame: AudioFrame): Buffer {
  const int16 = frame.data;
  switch (encoding) {
    case 'linear16':
      return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
    case 'linear32': {
      const out = Buffer.alloc(int16.length * 4);
      for (let i = 0; i < int16.length; i++) {
        out.writeInt32LE(int16[i]! * 65536, i * 4);
      }
      return out;
    }
    case 'mulaw': {
      const out = Buffer.alloc(int16.length);
      for (let i = 0; i < int16.length; i++) out[i] = linearToMulaw(int16[i]!);
      return out;
    }
    case 'alaw': {
      const out = Buffer.alloc(int16.length);
      for (let i = 0; i < int16.length; i++) out[i] = linearToAlaw(int16[i]!);
      return out;
    }
  }
}

function looksLikeErrorText(value: string): boolean {
  const lowered = value.toLowerCase();
  return [
    'error',
    'invalid',
    'failed',
    'forbidden',
    'unauthorized',
    'not found',
    'rate limit',
    'timeout',
  ].some((hint) => lowered.includes(hint));
}

// ---------------------------------------------------------------------------
// Server event shape (partial — only fields we read)
// ---------------------------------------------------------------------------

interface RealtimeServerEvent {
  event?: string;
  request_id?: string;
  session_id?: string;
  data?: { request_id?: string };
  metadata?: { request_id?: string };
  utterance_idx?: number;
  text?: string;
  language?: string;
  language_confidence?: number;
  confidence?: number;
  start_s?: number;
  end_s?: number;
  audio_duration_s?: number;
  applied?: unknown[];
  is_fatal?: boolean;
  code?: string;
  status_code?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// STTRealtime — connects to Sarvam's realtime WebSocket API (saaras:v3-realtime)
// ---------------------------------------------------------------------------

/**
 * Sarvam AI realtime speech-to-text, using the `saaras:v3-realtime` model.
 *
 * @remarks
 * Realtime streams don't reconnect after a socket failure — Sarvam bills per connection, so
 * `stream()` forces `connOptions.maxRetry = 0`. Create a new stream (or restart the session) if
 * the connection drops.
 *
 * `apiKey` must be set via the constructor argument or the `SARVAM_API_KEY` environment variable.
 *
 * @see {@link https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/realtime/ws | Sarvam realtime STT WebSocket docs}
 */
export class STTRealtime extends stt.STT {
  label = 'sarvam.STTRealtime';
  #opts: ResolvedRealtimeOptions;
  #streams = new Set<RealtimeSpeechStream>();

  constructor(opts: Partial<STTRealtimeOptions> = {}) {
    const resolved = resolveRealtimeOptions(opts);
    super({ streaming: true, interimResults: true, alignedTranscript: false });
    this.#opts = resolved;
  }

  get model(): string {
    return REALTIME_MODEL;
  }

  get provider(): string {
    return 'Sarvam';
  }

  /**
   * Update connection options for future streams. Fields marked connection-time only
   * (`sampleRate`, `returnTimestamps`, `vadPrefixPaddingMs`) apply only to newly created streams;
   * other fields are also forwarded as an in-band `config.update` to every currently open stream.
   */
  updateOptions(opts: Partial<STTRealtimeOptions>): void {
    this.#opts = resolveRealtimeOptions({ ...this.#opts, ...opts });
    for (const stream of this.#streams) {
      stream.updateOptions(opts);
    }
  }

  async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('Sarvam realtime STT only supports streaming recognition');
  }

  stream(options?: { language?: string; connOptions?: APIConnectOptions }): RealtimeSpeechStream {
    // This endpoint bills per connection, so the stream must never silently reconnect —
    // forcing max_retry to 0 mirrors the Python SDK's `stream()`.
    const connOptions: APIConnectOptions = {
      ...(options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS),
      maxRetry: 0,
    };
    const opts: ResolvedRealtimeOptions =
      options?.language !== undefined
        ? { ...this.#opts, language: normalizeLanguage(options.language) }
        : this.#opts;

    const stream = new RealtimeSpeechStream(this, opts, connOptions, () => {
      this.#streams.delete(stream);
    });
    this.#streams.add(stream);
    return stream;
  }
}

// ---------------------------------------------------------------------------
// RealtimeSpeechStream — per-connection state machine
// ---------------------------------------------------------------------------

export class RealtimeSpeechStream extends stt.SpeechStream {
  label = 'sarvam.RealtimeSpeechStream';
  #opts: ResolvedRealtimeOptions;
  #logger = log();
  #onClose?: () => void;
  #closeNotified = false;
  #ws?: WebSocket;

  #requestId = '';
  #sessionId = '';
  #sessionEnded = false;

  #activeEndpointing: RealtimeEndpointing;
  #pendingEndpointing?: RealtimeEndpointing;
  #endpointingUpdateAcknowledged = true;
  #endpointingUpdateSent = false;
  #pendingConfigUpdate: Record<string, unknown> | null = null;

  #manualSpeechStarted = false;
  #utteranceInProgress = false;
  #pendingFinalData: RealtimeServerEvent | null = null;
  #utteranceSpeechEndAudioPos: number | null = null;
  #utteranceSpeechEndWall: number | null = null;
  #finalReceivedForUtterance = false;
  #eosEmittedForUtterance = false;

  #audioPosition = 0;
  #totalReportedAudioDuration = 0;
  #serverAudioDurationReported = false;
  #audioDurationCollector: PeriodicCollector;

  constructor(
    sttInstance: STTRealtime,
    opts: ResolvedRealtimeOptions,
    connOptions: APIConnectOptions,
    onClose?: () => void,
  ) {
    super(sttInstance, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#activeEndpointing = opts.endpointing;
    this.#onClose = onClose;
    this.#audioDurationCollector = new PeriodicCollector((duration) => this.#emitUsage(duration), {
      duration: USAGE_FLUSH_INTERVAL_S,
    });
  }

  /** Update this stream's live options — see {@link STTRealtime.updateOptions}. */
  updateOptions(opts: Partial<STTRealtimeOptions>): void {
    const previous = this.#opts;
    let next = resolveRealtimeOptions({ ...previous, ...opts });

    const connectionOnly: string[] = [];
    if (next.sampleRate !== previous.sampleRate) {
      connectionOnly.push('sampleRate');
      next = { ...next, sampleRate: previous.sampleRate };
    }
    if (next.returnTimestamps !== previous.returnTimestamps) {
      connectionOnly.push('returnTimestamps');
      next = { ...next, returnTimestamps: previous.returnTimestamps };
    }
    if (next.vadPrefixPaddingMs !== previous.vadPrefixPaddingMs) {
      connectionOnly.push('vadPrefixPaddingMs');
      next = { ...next, vadPrefixPaddingMs: previous.vadPrefixPaddingMs };
    }
    if (next.encoding !== previous.encoding) {
      // Server's decoder is fixed at connect time by the `encoding` query param.
      connectionOnly.push('encoding');
      next = { ...next, encoding: previous.encoding };
    }
    if (connectionOnly.length > 0) {
      this.#logger.warn(
        { options: connectionOnly },
        'Sarvam realtime STT connection-only option updates only apply to new streams',
      );
    }

    this.#opts = next;

    if (next.endpointing !== previous.endpointing) {
      this.#pendingEndpointing = next.endpointing;
      this.#endpointingUpdateAcknowledged = false;
      this.#endpointingUpdateSent = false;
    }

    const update = buildConfigUpdatePayload(previous, next);
    if (update) {
      this.#pendingConfigUpdate = { ...this.#pendingConfigUpdate, ...update };
    }
  }

  close(): void {
    this.#flushLocalUsageFallback();
    try {
      this.#ws?.close();
    } catch {
      // already closing/closed
    }
    super.close();
    this.#notifyClosed();
  }

  /**
   * Notify {@link STTRealtime} that this stream is done, so it stops forwarding
   * `updateOptions()` calls to it. Idempotent: called from both `close()` (caller-initiated)
   * and `run()`'s `finally` (natural completion or error), which can race each other.
   */
  #notifyClosed(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.#onClose?.();
  }

  protected async run(): Promise<void> {
    const url = buildRealtimeWsUrl(this.#opts);
    const ws = new WebSocket(url, {
      headers: {
        'API-SUBSCRIPTION-KEY': this.#opts.apiKey,
        'User-Agent': 'LiveKit-Agents-JS',
      },
    });
    this.#ws = ws;
    // Scoped to this connection attempt: aborted once the server->client side settles (session
    // ended, or the socket closed) so the client->server audio pump — which would otherwise
    // block forever on this.input.next() waiting for a frame that may never come — stops too.
    const audioAbort = new AbortController();

    try {
      await waitForWebSocketOpen(ws, 'Sarvam realtime STT');

      const audioTask = this.#processAudio(ws, audioAbort.signal);
      const messagesTask = this.#processMessages(ws);

      const first = await Promise.race([
        audioTask.then(() => 'audio' as const),
        messagesTask.then(() => 'messages' as const),
        waitForAbort(this.abortSignal).then(() => 'abort' as const),
      ]);
      if (first === 'abort') return;

      // Whichever side finished first, stop the other and wait for it to settle. If audio
      // finished first (endInput()/flush()), this just waits for any trailing server messages
      // (e.g. a final transcript, session.end) as before. If messages finished first (server
      // ended the session or closed cleanly before the caller ended input), this now unblocks
      // the audio pump instead of leaving it hanging.
      audioAbort.abort();
      await Promise.all([audioTask, messagesTask]);
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIStatusError || error instanceof APIConnectionError) throw error;
      throw new APIConnectionError({
        message: `Sarvam realtime STT connection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      audioAbort.abort();
      try {
        ws.close();
      } catch {
        // already closing/closed
      }
      this.#ws = undefined;
      this.#notifyClosed();
    }
  }

  // -------------------------------------------------------------------------
  // Client -> server (audio pump)
  // -------------------------------------------------------------------------

  async #processAudio(ws: WebSocket, signal: AbortSignal): Promise<void> {
    const samplesPerChannel = Math.max(
      Math.floor((this.#opts.sampleRate * AUDIO_CHUNK_MS) / 1000),
      1,
    );
    const audioStream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS, samplesPerChannel);

    while (!this.#sessionEnded && ws.readyState === WebSocket.OPEN && !signal.aborted) {
      let result: IteratorResult<AudioFrame | typeof RealtimeSpeechStream.FLUSH_SENTINEL>;
      try {
        result = await this.input.next({ signal });
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }
      if (result.done) break;

      const data = result.value;
      this.#sendPendingConfigUpdate(ws);

      const isFlush = data === RealtimeSpeechStream.FLUSH_SENTINEL;
      let frames: AudioFrame[];
      if (isFlush) {
        frames = audioStream.flush();
      } else {
        if (data.channels !== NUM_CHANNELS) {
          throw new Error(
            `Sarvam realtime STT only supports mono audio (${NUM_CHANNELS} channel), got ${data.channels} channels`,
          );
        }
        frames = audioStream.write(
          data.data.buffer.slice(
            data.data.byteOffset,
            data.data.byteOffset + data.data.byteLength,
          ) as ArrayBuffer,
        );
      }

      this.#sendAudioFrames(ws, frames);

      if (isFlush) {
        this.#audioDurationCollector.flush();
        if (this.#activeEndpointing === 'manual' && this.#manualSpeechStarted) {
          this.#safeSendJson(ws, { event: 'speech_end' });
          this.#manualSpeechStarted = false;
          this.#endManualUtterance();
        }
      }
    }

    // Drain any audio still buffered in the framer (endInput() without a trailing flush()).
    if (!this.#sessionEnded && !signal.aborted && ws.readyState === WebSocket.OPEN) {
      this.#sendAudioFrames(ws, audioStream.flush());
    }

    this.#flushLocalUsageFallback();
    if (!this.#sessionEnded && !signal.aborted && ws.readyState === WebSocket.OPEN) {
      this.#safeSendJson(ws, { event: 'end' });
    }
  }

  #sendAudioFrames(ws: WebSocket, frames: AudioFrame[]): void {
    for (const frame of frames) {
      if (this.#activeEndpointing === 'manual' && !this.#manualSpeechStarted) {
        this.#safeSendJson(ws, { event: 'speech_start' });
        this.#manualSpeechStarted = true;
        this.#beginManualUtterance();
      }

      const duration = frame.samplesPerChannel / frame.sampleRate;
      this.#audioDurationCollector.push(duration);
      this.#audioPosition += duration;
      this.#safeSendBinary(ws, encodePcmForWire(this.#opts.encoding, frame));
    }
  }

  #sendPendingConfigUpdate(ws: WebSocket): void {
    if (!this.#pendingConfigUpdate) return;
    const payload = this.#pendingConfigUpdate;
    this.#pendingConfigUpdate = null;
    if ('endpointing' in payload) {
      this.#endpointingUpdateSent = true;
      this.#endpointingUpdateAcknowledged = false;
    }
    this.#safeSendJson(ws, payload);
  }

  #safeSendJson(ws: WebSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      this.#logger.debug({ error }, 'failed to send message to Sarvam realtime STT');
    }
  }

  #safeSendBinary(ws: WebSocket, data: Buffer): void {
    try {
      ws.send(data);
    } catch (error) {
      this.#logger.debug({ error }, 'failed to send audio to Sarvam realtime STT');
    }
  }

  // -------------------------------------------------------------------------
  // Server -> client (event loop)
  // -------------------------------------------------------------------------

  #processMessages(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
      };

      const onMessage = (raw: RawData, isBinary: boolean) => {
        if (isBinary) return; // Sarvam realtime only sends JSON text frames
        let parsed: RealtimeServerEvent;
        try {
          parsed = JSON.parse(raw.toString()) as RealtimeServerEvent;
        } catch {
          const text = raw.toString();
          if (looksLikeErrorText(text)) {
            cleanup();
            reject(new APIStatusError({ message: `Sarvam realtime STT error: ${text}` }));
          }
          return;
        }

        try {
          this.#handleMessage(parsed);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }

        if (this.#sessionEnded) {
          cleanup();
          resolve();
        }
      };

      const onError = (error: Error) => {
        cleanup();
        reject(
          new APIConnectionError({
            message: `Sarvam realtime STT WebSocket error: ${error.message}`,
          }),
        );
      };

      const onClose = (code: number, reasonBuf: Buffer) => {
        cleanup();
        const reason = reasonBuf.toString();
        if (this.#sessionEnded && (code === 1000 || code === 1001)) {
          resolve();
          return;
        }
        if ((code === 1000 || code === 1001) && !looksLikeErrorText(reason)) {
          resolve();
          return;
        }
        reject(this.#statusErrorFromClose(code, reason));
      };

      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
    });
  }

  #statusErrorFromClose(code: number, reason: string): APIStatusError {
    const retryable = code === 1013;
    let message = `Sarvam realtime STT WebSocket closed unexpectedly: ${reason}`;
    if (code === 1003) {
      message = 'Sarvam realtime STT authentication, quota, or rate limit error';
    } else if (code === 1008) {
      message = 'Sarvam realtime STT session timed out or exceeded the maximum duration';
    } else if (code === 1013) {
      message = 'Sarvam realtime STT backend temporarily unavailable';
    } else if (code === 4000) {
      message = `Sarvam realtime STT rejected the session: ${reason}`;
    }
    return new APIStatusError({
      message,
      options: {
        statusCode: code,
        requestId: this.#requestId || null,
        body: { closeCode: code, closeReason: reason },
        retryable,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------------

  #handleMessage(data: RealtimeServerEvent): void {
    this.#captureServerIds(data);
    switch (data.event) {
      case 'session.begin':
        return;
      case 'vad.speech_start':
        this.#resetUtteranceState();
        this.#utteranceInProgress = true;
        this.#put({ type: stt.SpeechEventType.START_OF_SPEECH, requestId: this.#requestId });
        return;
      case 'vad.speech_end':
        this.#handleSpeechEnd();
        return;
      case 'transcript.partial':
        this.#sendTranscriptEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, data);
        return;
      case 'transcript.final':
        if (this.#activeEndpointing === 'vad') {
          if (this.#isValidTranscript(data)) {
            this.#pendingFinalData = data;
            this.#finalReceivedForUtterance = true;
            this.#tryCommitUtterance();
          }
        } else if (this.#sendTranscriptEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, data)) {
          this.#finalReceivedForUtterance = true;
          this.#completeUtterance();
        }
        return;
      case 'session.end':
        this.#handleSessionEnd(data);
        return;
      case 'config.updated':
        this.#handleConfigUpdated(data);
        return;
      case 'error':
        this.#handleErrorEvent(data);
        return;
      case 'pong':
        return;
      default:
        this.#logger.debug({ event: data.event }, 'unknown Sarvam realtime STT event');
    }
  }

  #isValidTranscript(data: RealtimeServerEvent): boolean {
    return typeof data.text === 'string' && data.text.trim().length > 0;
  }

  #resetUtteranceState(): void {
    this.#pendingFinalData = null;
    this.#finalReceivedForUtterance = false;
    this.#eosEmittedForUtterance = false;
    this.#utteranceSpeechEndAudioPos = null;
    this.#utteranceSpeechEndWall = null;
  }

  #handleSpeechEnd(): void {
    this.#utteranceSpeechEndAudioPos = this.#audioPosition;
    this.#utteranceSpeechEndWall = Date.now();
    if (this.#activeEndpointing !== 'vad') {
      this.#emitEndOfSpeech();
    } else if (!this.#eosEmittedForUtterance) {
      // Commit a pending final first so consumers never see END_OF_SPEECH before it.
      if (this.#finalReceivedForUtterance) {
        this.#tryCommitUtterance();
      } else {
        this.#emitEndOfSpeech();
      }
    }
    this.#completeUtterance();
  }

  #tryCommitUtterance(): void {
    if (!this.#pendingFinalData || this.#utteranceSpeechEndAudioPos === null) return;
    const committed = this.#pendingFinalData;
    if (this.#sendTranscriptEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, committed)) {
      if (!this.#eosEmittedForUtterance) this.#emitEndOfSpeech();
      this.#pendingFinalData = null;
      this.#completeUtterance();
    }
  }

  #emitEndOfSpeech(): void {
    if (this.#eosEmittedForUtterance) return;
    this.#eosEmittedForUtterance = true;
    this.#put({
      type: stt.SpeechEventType.END_OF_SPEECH,
      requestId: this.#requestId,
      speechEndTime: this.#utteranceSpeechEndWall ?? Date.now(),
    });
  }

  #completeUtterance(): void {
    this.#utteranceInProgress = false;
    this.#applyPendingEndpointing();
  }

  #applyPendingEndpointing(): void {
    if (this.#pendingEndpointing && this.#endpointingUpdateAcknowledged) {
      this.#activeEndpointing = this.#pendingEndpointing;
      this.#pendingEndpointing = undefined;
    }
  }

  #beginManualUtterance(): void {
    this.#resetUtteranceState();
    this.#utteranceInProgress = true;
    this.#put({ type: stt.SpeechEventType.START_OF_SPEECH, requestId: this.#requestId });
  }

  #endManualUtterance(): void {
    this.#utteranceSpeechEndAudioPos = this.#audioPosition;
    this.#utteranceSpeechEndWall = Date.now();
    this.#emitEndOfSpeech();
    this.#completeUtterance();
  }

  #sendTranscriptEvent(type: stt.SpeechEventType, data: RealtimeServerEvent): boolean {
    const text = data.text;
    if (typeof text !== 'string' || !text.trim()) return false;

    const language = normalizeLanguage(data.language || this.#opts.language);
    let confidence = data.confidence;
    if (typeof confidence !== 'number' || Number.isNaN(confidence)) confidence = 1;

    const metadata: Record<string, unknown> = {};
    if (typeof data.utterance_idx === 'number') metadata.utteranceIdx = data.utterance_idx;
    if (typeof data.language_confidence === 'number') {
      metadata.languageConfidence = data.language_confidence;
    }
    if (type === stt.SpeechEventType.FINAL_TRANSCRIPT && this.#utteranceSpeechEndWall !== null) {
      metadata.speechEndWallTime = this.#utteranceSpeechEndWall;
    }

    let startTime = 0;
    let endTime = 0;
    if (type === stt.SpeechEventType.FINAL_TRANSCRIPT) {
      if (typeof data.start_s === 'number') startTime = Math.max(data.start_s, 0);
      if (typeof data.end_s === 'number') endTime = Math.max(data.end_s, 0);
      if (endTime === 0) {
        endTime =
          this.#utteranceSpeechEndAudioPos ?? (this.#audioPosition > 0 ? this.#audioPosition : 0);
      }
    }

    this.#put({
      type,
      requestId: this.#requestId,
      alternatives: [
        {
          language,
          text,
          startTime,
          endTime,
          confidence,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        },
      ],
    });
    return true;
  }

  #handleSessionEnd(data: RealtimeServerEvent): void {
    this.#captureServerIds(data);
    this.#flushTerminalUtterance();

    const audioDuration = data.audio_duration_s;
    if (typeof audioDuration === 'number' && !this.#serverAudioDurationReported) {
      this.#audioDurationCollector.flush();
      const serverAudioDuration = Math.max(audioDuration, 0);
      const delta = Math.max(serverAudioDuration - this.#totalReportedAudioDuration, 0);
      if (delta > 0) this.#emitUsage(delta);
      this.#serverAudioDurationReported = true;
    } else {
      this.#flushLocalUsageFallback();
    }
    this.#sessionEnded = true;
  }

  #flushTerminalUtterance(): void {
    if (this.#pendingFinalData && this.#utteranceSpeechEndAudioPos === null) {
      this.#utteranceSpeechEndAudioPos = this.#audioPosition;
      this.#utteranceSpeechEndWall = Date.now();
    }
    this.#tryCommitUtterance();
  }

  #flushLocalUsageFallback(): void {
    this.#audioDurationCollector.flush();
  }

  #emitUsage(duration: number): void {
    this.#totalReportedAudioDuration += duration;
    this.#put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: this.#requestId,
      recognitionUsage: { audioDuration: duration },
    });
  }

  #handleConfigUpdated(data: RealtimeServerEvent): void {
    const applied = Array.isArray(data.applied) ? data.applied.map(String) : [];
    const appliedEndpointing = applied.some((entry) => entry.startsWith('endpointing'));
    if (appliedEndpointing && this.#endpointingUpdateSent) {
      this.#endpointingUpdateAcknowledged = true;
      this.#endpointingUpdateSent = false;
      if (!this.#utteranceInProgress) this.#applyPendingEndpointing();
    }
  }

  #handleErrorEvent(data: RealtimeServerEvent): void {
    const code = data.code ?? 'unknown';
    if (!data.is_fatal) {
      this.#logger.warn(
        { code, 'lk.pii.message': data.message },
        'non-fatal Sarvam realtime STT error',
      );
      return;
    }
    const statusCode = typeof data.status_code === 'number' ? data.status_code : -1;
    this.#logger.error(
      { code, statusCode, 'lk.pii.message': data.message },
      'fatal Sarvam realtime STT error',
    );
    // The raw provider message/payload may carry account or transcript-adjacent details, so it's
    // only logged (tagged lk.pii.* above) — the thrown error's own message and body stay generic.
    throw new APIStatusError({
      message: `Sarvam realtime STT error (${code})`,
      options: {
        statusCode,
        requestId: this.#requestId || null,
        retryable: code === 'model_unavailable',
      },
    });
  }

  #captureServerIds(data: RealtimeServerEvent): void {
    if (typeof data.session_id === 'string' && data.session_id) {
      this.#sessionId = data.session_id;
    }
    if (!this.#requestId) {
      const requestId = data.request_id ?? data.data?.request_id ?? data.metadata?.request_id;
      if (typeof requestId === 'string' && requestId) this.#requestId = requestId;
    }
    void this.#sessionId; // tracked for diagnostics; not currently surfaced on SpeechEvent
  }

  #put(event: stt.SpeechEvent): void {
    if (!this.queue.closed) this.queue.put(event);
  }
}
