// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  type AudioBuffer,
  AudioByteStream,
  ConnectionPool,
  DEFAULT_API_CONNECT_OPTIONS,
  type VAD,
  VADEventType,
  type VADStream,
  asLanguageCode,
  calculateAudioDurationSeconds,
  createTimedString,
  log,
  mergeFrames,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { Mistral } from '@mistralai/mistralai';
import type { RealtimeConnection, RealtimeEvent } from '@mistralai/mistralai/extra/realtime';
import { RealtimeTranscription } from '@mistralai/mistralai/extra/realtime';
import type { MistralSTTModels } from './models.js';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const DEFAULT_MODEL = 'voxtral-mini-transcribe-realtime-3';

function isRealtime(model: string): boolean {
  return model.includes('realtime');
}

function isVoxtral3(model: string): boolean {
  return /-transcribe(-realtime)?-3(-|$)/.test(model);
}

/**
 * Server-side turn detection settings for Voxtral 3 realtime models.
 *
 * Thresholds must satisfy `startThreshold >= eagerEndThreshold > endThreshold`, and
 * `endTimeoutMs` must be at least `minSilenceMs`.
 */
export interface TurnDetection {
  startThreshold?: number;
  eagerEndThreshold?: number;
  endThreshold?: number;
  minSilenceMs?: number;
  endTimeoutMs?: number | null;
}

export interface STTOptions {
  model: MistralSTTModels | string;
  language?: string | null;
  contextBias?: string[] | null;
  targetStreamingDelayMs?: number | null;
  diarize?: boolean;
  turnDetection?: TurnDetection | null;
  apiKey?: string;
  client?: Mistral;
  vad?: VAD;
}

export interface STTRecognizeOptions {
  language?: string | null;
  abortSignal?: AbortSignal;
}

type ResolvedSTTOptions = {
  model: string;
  language: string | null;
  contextBias: string[] | null;
  targetStreamingDelayMs: number | null;
  diarize: boolean;
  turnDetection: TurnDetection | null;
};

type RawEvent = Record<string, unknown>;
type RawWebSocket = {
  send(data: string, callback: (error?: Error) => void): void;
};

/** @internal */
export function _isProviderProgressEvent(type: unknown): boolean {
  return (
    type === 'transcription.language' ||
    type === 'transcription.text.delta' ||
    type === 'transcription.segment' ||
    type === 'transcription.done'
  );
}

class DeferredEvent {
  isSet = false;
  #promise: Promise<void>;
  #resolve?: () => void;

  constructor() {
    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  wait(): Promise<void> {
    return this.#promise;
  }

  set(): void {
    if (this.isSet) return;
    this.isSet = true;
    this.#resolve?.();
  }

  clear(): void {
    if (!this.isSet) return;
    this.isSet = false;
    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }
}

function cloneTurnDetection(value: TurnDetection | null): TurnDetection | null {
  return value === null ? null : { ...value };
}

function sameTurnDetection(a: TurnDetection | null, b: TurnDetection | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rawWebSocket(connection: RealtimeConnection): RawWebSocket {
  return (connection as unknown as { websocket: RawWebSocket }).websocket;
}

async function sendRaw(connection: RealtimeConnection, data: RawEvent): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    rawWebSocket(connection).send(JSON.stringify(data), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function turnDetectionFields(value: TurnDetection): RawEvent {
  const fields: RawEvent = {};
  if (value.startThreshold !== undefined) fields.start_threshold = value.startThreshold;
  if (value.eagerEndThreshold !== undefined) fields.eager_end_threshold = value.eagerEndThreshold;
  if (value.endThreshold !== undefined) fields.end_threshold = value.endThreshold;
  if (value.minSilenceMs !== undefined) fields.min_silence_ms = value.minSilenceMs;
  if (value.endTimeoutMs !== undefined) fields.end_timeout_ms = value.endTimeoutMs;
  return fields;
}

function isAbortSignal(value: AbortSignal | STTRecognizeOptions | undefined): value is AbortSignal {
  return value !== undefined && 'aborted' in value && 'addEventListener' in value;
}

export class STT extends stt.STT {
  #opts: ResolvedSTTOptions;
  #client: Mistral;
  #vad: VAD | undefined;
  #pool: ConnectionPool<RealtimeConnection>;
  #streams = new Set<WeakRef<SpeechStream>>();
  label = 'mistral.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    const model = opts.model ?? DEFAULT_MODEL;
    const realtime = isRealtime(model);
    const diarize = opts.diarize ?? false;

    if (diarize && realtime && !isVoxtral3(model)) {
      throw new Error('diarization is not supported by this realtime model');
    }

    let turnDetection: TurnDetection | null = null;
    if (realtime && isVoxtral3(model)) {
      if (opts.turnDetection !== undefined) {
        turnDetection = cloneTurnDetection(opts.turnDetection);
      } else if (!diarize && opts.vad === undefined) {
        turnDetection = {};
      }
    } else if (opts.turnDetection !== undefined && opts.turnDetection !== null) {
      throw new Error('turn detection is only supported by the latest realtime model');
    }

    if (diarize && turnDetection !== null) {
      throw new Error("diarization and turn detection can't be used together");
    }
    if (opts.vad !== undefined && turnDetection !== null) {
      throw new Error("a vad and turn detection can't be used together");
    }

    super({
      streaming: realtime,
      interimResults: realtime,
      manualFlush: realtime && turnDetection === null && opts.vad === undefined,
      alignedTranscript: false,
      diarization: diarize,
    });

    if (!opts.apiKey && !opts.client && !process.env.MISTRAL_API_KEY) {
      throw new Error(
        'Mistral API key is required, either as an argument or via MISTRAL_API_KEY env var',
      );
    }

    this.#opts = {
      model,
      language: opts.language ?? null,
      contextBias: opts.contextBias?.length ? [...opts.contextBias] : null,
      targetStreamingDelayMs: opts.targetStreamingDelayMs ?? null,
      diarize,
      turnDetection,
    };
    this.#vad = realtime ? opts.vad : undefined;
    this.#client =
      opts.client ?? new Mistral({ apiKey: opts.apiKey ?? process.env.MISTRAL_API_KEY });
    this.#pool = new ConnectionPool({
      connectCb: (timeout) => this.#connect(timeout),
      closeCb: (connection) => connection.close(),
    });
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'api.mistral.ai';
  }

  prewarm(): void {
    if (isRealtime(this.#opts.model)) this.#pool.prewarm();
  }

  updateOptions(
    opts: Partial<
      Pick<
        STTOptions,
        | 'model'
        | 'language'
        | 'contextBias'
        | 'targetStreamingDelayMs'
        | 'diarize'
        | 'turnDetection'
      >
    >,
  ): void {
    const model = opts.model ?? this.#opts.model;
    const diarize = opts.diarize ?? this.#opts.diarize;
    const wasVoxtral3Realtime = isRealtime(this.#opts.model) && isVoxtral3(this.#opts.model);
    const voxtral3Realtime = isRealtime(model) && isVoxtral3(model);

    let turnDetection: TurnDetection | null = null;
    if (opts.turnDetection !== undefined) {
      turnDetection = cloneTurnDetection(opts.turnDetection);
    } else if (voxtral3Realtime) {
      if (wasVoxtral3Realtime && diarize === this.#opts.diarize) {
        turnDetection = cloneTurnDetection(this.#opts.turnDetection);
      } else if (!diarize && this.#vad === undefined) {
        turnDetection = {};
      }
    }

    if (isRealtime(model) !== this.capabilities.streaming) {
      throw new Error(
        `can't switch from ${this.#opts.model} to ${model}: this STT was created with a ${this.capabilities.streaming ? 'realtime' : 'batch'} model, create a new STT to use the other kind`,
      );
    }
    if (turnDetection !== null && !voxtral3Realtime) {
      throw new Error('turn detection is only supported by the latest realtime model');
    }
    if (diarize && isRealtime(model) && !voxtral3Realtime) {
      throw new Error('diarization is not supported by this realtime model');
    }
    if (diarize && turnDetection !== null) {
      throw new Error("diarization and turn detection can't be used together");
    }
    if (this.#vad !== undefined && turnDetection !== null) {
      throw new Error("a vad and turn detection can't be used together");
    }

    const language = opts.language !== undefined ? opts.language : this.#opts.language;
    const contextBias =
      opts.contextBias !== undefined
        ? opts.contextBias?.length
          ? [...opts.contextBias]
          : null
        : this.#opts.contextBias;
    const targetStreamingDelayMs =
      opts.targetStreamingDelayMs !== undefined
        ? opts.targetStreamingDelayMs
        : this.#opts.targetStreamingDelayMs;
    const sessionChanged =
      model !== this.#opts.model ||
      diarize !== this.#opts.diarize ||
      !sameTurnDetection(turnDetection, this.#opts.turnDetection) ||
      targetStreamingDelayMs !== this.#opts.targetStreamingDelayMs ||
      (voxtral3Realtime &&
        (language !== this.#opts.language ||
          JSON.stringify(contextBias) !== JSON.stringify(this.#opts.contextBias)));

    this.#opts = {
      model,
      language: language ?? null,
      contextBias,
      targetStreamingDelayMs: targetStreamingDelayMs ?? null,
      diarize,
      turnDetection,
    };
    this.updateCapabilities({
      diarization: diarize,
      manualFlush: this.capabilities.streaming && turnDetection === null && this.#vad === undefined,
    });

    if (sessionChanged && this.capabilities.streaming) {
      this.#pool.invalidate();
      for (const ref of this.#streams) {
        const stream = ref.deref();
        if (stream) stream._reconnect(this.#opts);
        else this.#streams.delete(ref);
      }
    }
  }

  async recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent>;
  async recognize(buffer: AudioBuffer, options?: STTRecognizeOptions): Promise<stt.SpeechEvent>;
  async recognize(
    buffer: AudioBuffer,
    optionsOrAbortSignal?: AbortSignal | STTRecognizeOptions,
  ): Promise<stt.SpeechEvent> {
    const options = isAbortSignal(optionsOrAbortSignal)
      ? { abortSignal: optionsOrAbortSignal }
      : optionsOrAbortSignal ?? {};
    const started = process.hrtime.bigint();
    const event = await this.#recognize(buffer, options.language, options.abortSignal);
    event.createdAt ??= Date.now();
    this.emit('metrics_collected', {
      type: 'stt_metrics',
      requestId: event.requestId ?? '',
      timestamp: Date.now(),
      durationMs: Number((process.hrtime.bigint() - started) / BigInt(1_000_000)),
      label: this.label,
      audioDurationMs: Math.round(calculateAudioDurationSeconds(buffer) * 1000),
      streamed: false,
      metadata: { modelProvider: this.provider, modelName: this.model },
    });
    return event;
  }

  protected async _recognize(
    buffer: AudioBuffer,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    return this.#recognize(buffer, undefined, abortSignal);
  }

  async #recognize(
    buffer: AudioBuffer,
    languageOverride?: string | null,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    try {
      const frame = mergeFrames(buffer);
      const wavBytes = createWav(frame);
      const language = languageOverride !== undefined ? languageOverride : this.#opts.language;
      const resp = await this.#client.audio.transcriptions.complete(
        {
          model: this.#opts.model,
          file: new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' }),
          language: language ?? undefined,
          contextBias: this.#opts.contextBias ?? undefined,
          diarize: this.#opts.diarize,
          timestampGranularities: ['segment'],
        },
        { signal: abortSignal },
      );
      const segments = resp.segments ?? [];
      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            text: resp.text ?? '',
            language: asLanguageCode(resp.language ?? language ?? ''),
            startTime: segments[0]?.start ?? 0,
            endTime: segments[segments.length - 1]?.end ?? 0,
            confidence: 0,
            speakerId: segments.find((segment) => segment.speakerId)?.speakerId ?? null,
            words: segments.length
              ? segments.map((segment) =>
                  createTimedString({
                    text: segment.text,
                    startTime: segment.start,
                    endTime: segment.end,
                    speakerId: segment.speakerId,
                  }),
                )
              : undefined,
          },
        ],
      };
    } catch (error) {
      throw mapError(error);
    }
  }

  stream(
    options: { language?: string | null; connOptions?: APIConnectOptions } = {},
  ): SpeechStream {
    if (!isRealtime(this.#opts.model)) {
      throw new Error(
        `Streaming is only supported for realtime models. Current model: ${this.#opts.model}`,
      );
    }
    const stream = new SpeechStream(
      this,
      this.#pool,
      this.#opts,
      this.#vad,
      options.language,
      options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    );
    this.#streams.add(new WeakRef(stream));
    return stream;
  }

  async close(): Promise<void> {
    await this.#pool.close();
  }

  async #connect(timeout: number): Promise<RealtimeConnection> {
    try {
      const connection = await new RealtimeTranscription(this.#client._options).connect(
        this.#opts.model,
        { timeoutMs: timeout },
      );
      const session = this.#sessionFields();
      if (Object.keys(session).length) {
        try {
          await sendRaw(connection, { type: 'session.update', session });
        } catch (error) {
          await connection.close();
          throw error;
        }
      }
      return connection;
    } catch (error) {
      throw mapError(error);
    }
  }

  #sessionFields(): RawEvent {
    const fields: RawEvent = {};
    if (this.#opts.targetStreamingDelayMs !== null) {
      fields.target_streaming_delay_ms = this.#opts.targetStreamingDelayMs;
    }
    if (isRealtime(this.#opts.model) && isVoxtral3(this.#opts.model)) {
      if (this.#opts.language) fields.language = this.#opts.language;
      if (this.#opts.contextBias) fields.context_bias = [...this.#opts.contextBias];
      if (this.#opts.diarize) fields.diarize = true;
      if (this.#opts.turnDetection !== null) {
        fields.turn_detection = turnDetectionFields(this.#opts.turnDetection);
      }
    }
    return fields;
  }
}

export class SpeechStream extends stt.SpeechStream {
  #pool: ConnectionPool<RealtimeConnection>;
  #opts: ResolvedSTTOptions;
  #vad: VAD | undefined;
  #language: string | null;
  #connOptions: APIConnectOptions;
  #reconnectEvent = new DeferredEvent();
  #requestId = '';
  #speaking = false;
  #audioPending = false;
  #audioEnded = false;
  #currentText = '';
  #preflightText = '';
  #detectedLanguage = '';
  #logger = log();
  label = 'mistral.SpeechStream';

  constructor(
    sttInstance: STT,
    pool: ConnectionPool<RealtimeConnection>,
    opts: ResolvedSTTOptions,
    vad: VAD | undefined,
    language: string | null | undefined,
    connOptions: APIConnectOptions,
  ) {
    super(sttInstance, SAMPLE_RATE, connOptions);
    this.#pool = pool;
    this.#opts = opts;
    this.#vad = vad;
    this.#language = language ?? null;
    this.#connOptions = connOptions;
    this.#detectedLanguage = language ?? '';
  }

  /** @internal */
  _reconnect(opts: ResolvedSTTOptions): void {
    this.#opts = opts;
    this.#reconnectEvent.set();
  }

  protected async run(): Promise<void> {
    while (!this.closed) {
      let connection: RealtimeConnection | undefined;
      let vadStream: VADStream | undefined;
      const taskAbort = new AbortController();
      try {
        connection = await this.#pool.get(this.#connOptions.timeoutMs, this.abortSignal);
        this.#audioPending = false;
        this.#audioEnded = false;
        await this.#applyStreamLanguage(connection);
        vadStream = this.#vad?.stream();

        const sendTask = this.#sendTask(connection, vadStream, taskAbort.signal);
        const recvTask = this.#recvTask(connection);
        const vadTask = vadStream
          ? this.#vadTask(vadStream, connection).then(() => new Promise<never>(() => {}))
          : new Promise<never>(() => {});
        const result = await Promise.race([
          sendTask.then(() => 'send' as const),
          recvTask.then(() => 'recv' as const),
          vadTask.then(() => 'vad' as const),
          this.#reconnectEvent.wait().then(() => 'reconnect' as const),
          waitForSignal(this.abortSignal).then(() => 'abort' as const),
        ]);

        if (result === 'abort') return;
        if (result === 'reconnect') {
          this.#reconnectEvent.clear();
          if (this.#speaking) {
            this.#speaking = false;
            this.#put({ type: stt.SpeechEventType.END_OF_SPEECH });
          }
          continue;
        }
        if (result === 'recv' && !this.#audioEnded) {
          throw new APIConnectionError({
            message: 'Mistral STT connection closed unexpectedly',
            options: { retryable: true },
          });
        }
        if (result === 'send') await recvTask;
        break;
      } catch (error) {
        if (this.abortSignal.aborted) return;
        if (error instanceof APIStatusError || error instanceof APIConnectionError) throw error;
        throw mapError(error);
      } finally {
        taskAbort.abort();
        vadStream?.close();
        if (connection) this.#pool.remove(connection);
      }
    }
  }

  async #applyStreamLanguage(connection: RealtimeConnection): Promise<void> {
    if (
      this.#language &&
      this.#language !== this.#opts.language &&
      isRealtime(this.#opts.model) &&
      isVoxtral3(this.#opts.model)
    ) {
      await sendRaw(connection, {
        type: 'session.update',
        session: { language: this.#language },
      });
    }
  }

  async #sendAudio(connection: RealtimeConnection, data: Uint8Array): Promise<void> {
    await connection.sendAudio(data);
    this.#audioPending = true;
  }

  async #flushAudio(connection: RealtimeConnection): Promise<void> {
    if (!this.#audioPending) return;
    this.#audioPending = false;
    await connection.flushAudio();
  }

  async #sendTask(
    connection: RealtimeConnection,
    vadStream: VADStream | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const audio = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, Math.floor(SAMPLE_RATE / 20));
    while (!signal.aborted) {
      let result: IteratorResult<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL>;
      try {
        result = await this.input.next({ signal });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (result.done) break;
      const data = result.value;
      if (data === SpeechStream.FLUSH_SENTINEL) {
        for (const frame of audio.flush()) await this.#sendAudio(connection, audioBytes(frame));
        await this.#flushAudio(connection);
      } else {
        vadStream?.pushFrame(data);
        for (const frame of audio.write(data.data)) {
          await this.#sendAudio(connection, audioBytes(frame));
        }
      }
    }
    if (signal.aborted) return;
    vadStream?.close();
    await connection.endAudio();
    this.#audioEnded = true;
  }

  async #vadTask(vadStream: VADStream, connection: RealtimeConnection): Promise<void> {
    for await (const event of vadStream) {
      if (event.type === VADEventType.START_OF_SPEECH && !this.#speaking) {
        this.#speaking = true;
        this.#put({ type: stt.SpeechEventType.START_OF_SPEECH });
      } else if (event.type === VADEventType.END_OF_SPEECH) {
        await this.#flushAudio(connection);
        if (this.#speaking) {
          this.#speaking = false;
          this.#put({ type: stt.SpeechEventType.END_OF_SPEECH });
        }
      }
    }
  }

  async #recvTask(connection: RealtimeConnection): Promise<void> {
    this.#requestId = connection.requestId;
    this.#currentText = '';
    this.#preflightText = '';
    for await (const sdkEvent of connection.events()) {
      const event = normalizeEvent(sdkEvent);
      if (event) {
        await this.#onEvent(connection, event);
      } else {
        this.#logger.warn('ignoring an invalid message from Mistral STT');
      }
    }
  }

  async #onEvent(connection: RealtimeConnection, event: RawEvent): Promise<void> {
    const type = event.type;
    if (_isProviderProgressEvent(type)) this.markProviderProgress();
    if (type === 'session.created' || type === 'session.updated') {
      const session = asRecord(event.session);
      const requestId = stringValue(session?.request_id ?? session?.requestId);
      if (requestId) this.#requestId = requestId;
    } else if (type === 'transcription.language') {
      const language = stringValue(event.audio_language ?? event.audioLanguage);
      if (language) this.#detectedLanguage = language;
    } else if (type === 'transcription.text.delta') {
      this.#onText(stringValue(event.text) ?? '');
    } else if (type === 'transcription.segment') {
      this.#onText(stringValue(event.text) ?? '', stringValue(event.speaker_id ?? event.speakerId));
    } else if (type === 'transcription.done') {
      this.#onDone(event);
    } else if (type === 'error') {
      const detail = asRecord(event.error) ?? {};
      const code = detail.code;
      throw new APIStatusError({
        message: `Mistral STT: realtime error - ${String(detail.message ?? 'unknown error')}`,
        options: {
          statusCode: typeof code === 'number' ? code : -1,
          requestId: this.#requestId || undefined,
          body: detail,
          retryable: false,
        },
      });
    } else if (typeof type === 'string' && type.startsWith('turn.')) {
      await this.#onTurnEvent(connection, type);
    } else {
      this.#logger.warn({ 'lk.pii.event': event }, 'received unexpected message from Mistral STT');
    }
  }

  #onText(text: string, speakerId?: string): void {
    this.#currentText += text;
    this.#put({
      type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
      requestId: this.#requestId,
      alternatives: [this.#speechData(this.#currentText, speakerId)],
    });
  }

  #onDone(event: RawEvent): void {
    this.#currentText = '';
    this.#preflightText = '';
    const segments = Array.isArray(event.segments)
      ? event.segments.map(asRecord).filter((segment): segment is RawEvent => segment !== undefined)
      : [];
    const text = stringValue(event.text) ?? '';
    const language = stringValue(event.language) ?? this.#detectedLanguage;
    const words = segments.length
      ? segments.map((segment) => {
          const start = numberValue(segment.start);
          const end = numberValue(segment.end);
          return createTimedString({
            text: stringValue(segment.text) ?? '',
            startTime: start === undefined ? undefined : start + this.startTimeOffset,
            endTime: end === undefined ? undefined : end + this.startTimeOffset,
            speakerId: stringValue(segment.speaker_id ?? segment.speakerId),
          });
        })
      : undefined;

    if (text || segments.length || !this.#audioEnded) {
      const firstSpeaker = segments
        .map((segment) => stringValue(segment.speaker_id ?? segment.speakerId))
        .find(Boolean);
      this.#put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId: this.#requestId,
        alternatives: [
          {
            ...this.#speechData(text, firstSpeaker),
            language: asLanguageCode(language),
            words,
          },
        ],
      });
    }

    const usage = asRecord(event.usage) ?? {};
    this.#put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: this.#requestId,
      recognitionUsage: {
        audioDuration: numberValue(usage.prompt_audio_seconds ?? usage.promptAudioSeconds) ?? 0,
        inputTokens: numberValue(usage.prompt_tokens ?? usage.promptTokens) ?? 0,
        outputTokens: numberValue(usage.completion_tokens ?? usage.completionTokens) ?? 0,
      },
    });
  }

  async #onTurnEvent(connection: RealtimeConnection, type: string): Promise<void> {
    if (type === 'turn.start') {
      if (!this.#speaking) {
        this.#speaking = true;
        this.#put({ type: stt.SpeechEventType.START_OF_SPEECH });
      }
    } else if (type === 'turn.eager_end') {
      if (this.#speaking && this.#currentText && this.#currentText !== this.#preflightText) {
        this.#preflightText = this.#currentText;
        this.#put({
          type: stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
          requestId: this.#requestId,
          alternatives: [this.#speechData(this.#currentText)],
        });
      }
    } else if (type === 'turn.resume') {
      if (this.#speaking && this.#currentText) this.#onText('');
    } else if (type === 'turn.end') {
      await this.#flushAudio(connection);
      if (this.#speaking) {
        this.#speaking = false;
        this.#put({ type: stt.SpeechEventType.END_OF_SPEECH });
      }
    }
  }

  #speechData(text: string, speakerId?: string): stt.SpeechData {
    return {
      text,
      language: asLanguageCode(this.#detectedLanguage),
      startTime: 0,
      endTime: 0,
      confidence: 0,
      speakerId: speakerId ?? null,
    };
  }

  #put(event: stt.SpeechEvent): void {
    if (!this.queue.closed) this.queue.put(event);
  }
}

function normalizeEvent(event: RealtimeEvent): RawEvent | undefined {
  if ('raw' in event) {
    const raw = asRecord(event.raw);
    return raw;
  }
  return event as unknown as RawEvent;
}

function asRecord(value: unknown): RawEvent | undefined {
  return typeof value === 'object' && value !== null ? (value as RawEvent) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function waitForSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

function mapError(error: unknown): APIStatusError | APIConnectionError {
  if (error instanceof APIStatusError || error instanceof APIConnectionError) return error;
  const err = error as {
    statusCode?: number;
    status?: number;
    message?: string;
    headers?: Record<string, string>;
    body?: unknown;
    code?: number;
    name?: string;
    payload?: unknown;
    rawPayload?: unknown;
    cause?: { statusCode?: number; status?: number };
  };
  if (err.name === 'RealtimeTranscriptionWSError') {
    return new APIStatusError({
      message: `Mistral STT: realtime error - ${err.message ?? 'unknown error'}`,
      options: {
        statusCode: err.code ?? -1,
        body: errorBody(err.payload ?? err.rawPayload),
        retryable: false,
      },
    });
  }
  const statusCode = statusFromError(error);
  if (statusCode !== undefined) {
    return new APIStatusError({
      message: `Mistral STT: error (${statusCode}) - ${err.message ?? 'unknown error'}`,
      options: {
        statusCode,
        requestId: err.headers?.['x-request-id'],
        body: errorBody(err.body),
        retryable:
          statusCode !== 429 && (statusCode === 408 || statusCode === 499 || statusCode >= 500),
      },
    });
  }
  return new APIConnectionError({
    message: `Mistral STT: connection error - ${err.message ?? 'unknown error'}`,
    options: { retryable: true },
  });
}

function statusFromError(error: unknown): number | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const value = current as {
      statusCode?: unknown;
      status?: unknown;
      response?: { statusCode?: unknown; status?: unknown };
      cause?: unknown;
      message?: unknown;
    };
    const status =
      value.statusCode ?? value.status ?? value.response?.statusCode ?? value.response?.status;
    if (typeof status === 'number') return status;
    if (typeof value.message === 'string') {
      const match = /(?:status|response):?\s*(\d{3})/i.exec(value.message);
      if (match) return Number(match[1]);
    }
    current = value.cause;
  }
  return undefined;
}

function errorBody(value: unknown): object | string | number | boolean | null | undefined {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value as string | number | boolean | null;
  }
  return asRecord(value);
}

function audioBytes(frame: AudioFrame): Uint8Array {
  return new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
}

function createWav(frame: AudioFrame): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
  const blockAlign = (frame.channels * bitsPerSample) / 8;
  const dataSize = frame.data.byteLength;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const encoder = new TextEncoder();
  new Uint8Array(header, 0, 4).set(encoder.encode('RIFF'));
  view.setUint32(4, 36 + dataSize, true);
  new Uint8Array(header, 8, 4).set(encoder.encode('WAVE'));
  new Uint8Array(header, 12, 4).set(encoder.encode('fmt '));
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, frame.channels, true);
  view.setUint32(24, frame.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  new Uint8Array(header, 36, 4).set(encoder.encode('data'));
  view.setUint32(40, dataSize, true);
  const result = new Uint8Array(44 + dataSize);
  result.set(new Uint8Array(header));
  result.set(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), 44);
  return result;
}
