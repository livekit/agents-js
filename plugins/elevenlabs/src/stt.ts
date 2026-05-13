// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  Future,
  Task,
  calculateAudioDurationSeconds,
  createTimedString,
  delay,
  intervalForRetry,
  log,
  mergeFrames,
  normalizeLanguage,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import { PeriodicCollector } from './_utils.js';
import type { STTRealtimeSampleRates } from './models.js';

const API_BASE_URL_V1 = 'https://api.elevenlabs.io/v1';
const AUTHORIZATION_HEADER = 'xi-api-key';

export interface VADOptions {
  vadSilenceThresholdSecs?: number | null;
  vadThreshold?: number | null;
  minSpeechDurationMs?: number | null;
  minSilenceDurationMs?: number | null;
}

export type ElevenLabsSTTModels = 'scribe_v1' | 'scribe_v2' | 'scribe_v2_realtime';

export interface STTHTTPSession {
  fetch?: typeof fetch;
  wsConnect?: (
    url: string,
    options: { headers: Record<string, string>; signal?: AbortSignal; timeoutMs?: number },
  ) => WebSocket | Promise<WebSocket>;
}

export interface STTOptions {
  apiKey?: string;
  baseURL?: string;
  languageCode?: string;
  tagAudioEvents?: boolean;
  useRealtime?: boolean;
  sampleRate?: STTRealtimeSampleRates;
  serverVad?: VADOptions | null;
  includeTimestamps?: boolean;
  httpSession?: STTHTTPSession;
  modelId?: ElevenLabsSTTModels | string;
  keyterms?: string[];
}

interface ResolvedSTTOptions {
  modelId: ElevenLabsSTTModels | string;
  apiKey: string;
  baseURL: string;
  languageCode?: string;
  tagAudioEvents: boolean;
  includeTimestamps: boolean;
  sampleRate: STTRealtimeSampleRates;
  serverVad?: VADOptions | null;
  keyterms?: string[];
}

export interface STTRecognizeOptions {
  language?: string;
  connOptions?: APIConnectOptions;
  abortSignal?: AbortSignal;
}

interface ElevenLabsWord {
  text?: string;
  start?: number;
  end?: number;
  speaker_id?: string | null;
}

interface ElevenLabsBatchResponse {
  text?: string;
  language_code?: string;
  words?: ElevenLabsWord[];
  detail?: string;
}

interface ElevenLabsStreamEvent {
  message_type?: string;
  text?: string;
  words?: ElevenLabsWord[];
  language_code?: string;
  session_id?: string;
  message?: string;
  details?: string;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' && value !== null && 'aborted' in value && 'addEventListener' in value
  );
}

function createWav(frame: AudioFrame): Buffer {
  const bitsPerSample = 16;
  const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
  const blockAlign = (frame.channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + frame.data.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(frame.channels, 22);
  header.writeUInt32LE(frame.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(frame.data.byteLength, 40);

  const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  return Buffer.concat([header, pcm]);
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asWords(value: unknown): ElevenLabsWord[] {
  if (!Array.isArray(value)) return [];
  return value.map((word) => {
    const record = toRecord(word);
    return {
      text: asString(record.text),
      start: asNumber(record.start),
      end: asNumber(record.end),
      speaker_id: asString(record.speaker_id) ?? null,
    };
  });
}

function parseBatchResponse(value: unknown): ElevenLabsBatchResponse {
  const record = toRecord(value);
  return {
    text: asString(record.text),
    language_code: asString(record.language_code),
    words: asWords(record.words),
    detail: asString(record.detail),
  };
}

function parseStreamEvent(value: unknown): ElevenLabsStreamEvent {
  const record = toRecord(value);
  return {
    message_type: asString(record.message_type),
    text: asString(record.text),
    words: asWords(record.words),
    language_code: asString(record.language_code),
    session_id: asString(record.session_id),
    message: asString(record.message),
    details: asString(record.details),
  };
}

export class STT extends stt.STT {
  #opts: ResolvedSTTOptions;
  #session: STTHTTPSession;
  #streams = new Set<WeakRef<SpeechStream>>();
  #logger = log();

  label = 'elevenlabs.STT';

  constructor(opts: STTOptions = {}) {
    let modelId = opts.modelId;
    if (opts.useRealtime !== undefined) {
      if (modelId !== undefined) {
        log().warn(
          'both `useRealtime` and `modelId` parameters are provided. `useRealtime` will be ignored.',
        );
      } else {
        log().warn(
          '`useRealtime` parameter is deprecated. Specify a realtime modelId to enable streaming. Defaulting modelId to one based on useRealtime parameter.',
        );
        modelId = opts.useRealtime ? 'scribe_v2_realtime' : 'scribe_v1';
      }
    }
    modelId = modelId ?? 'scribe_v1';
    const useRealtime = modelId === 'scribe_v2_realtime';

    if (!useRealtime && opts.serverVad !== undefined) {
      log().warn('Server-side VAD is only supported for Scribe v2 realtime model');
    }

    const includeTimestamps = opts.includeTimestamps ?? false;
    super({
      streaming: useRealtime,
      interimResults: true,
      alignedTranscript: includeTimestamps && useRealtime ? 'word' : false,
    });

    const apiKey = opts.apiKey ?? process.env.ELEVEN_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ElevenLabs API key is required, either as argument or set ELEVEN_API_KEY environmental variable',
      );
    }

    this.#opts = {
      apiKey,
      baseURL: opts.baseURL ?? API_BASE_URL_V1,
      languageCode: opts.languageCode ? normalizeLanguage(opts.languageCode) : undefined,
      tagAudioEvents: opts.tagAudioEvents ?? true,
      sampleRate: opts.sampleRate ?? 16000,
      serverVad: opts.serverVad,
      includeTimestamps,
      modelId,
      keyterms: opts.keyterms,
    };
    this.#session = opts.httpSession ?? {};
  }

  get model(): string {
    return this.#opts.modelId;
  }

  get provider(): string {
    return 'ElevenLabs';
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
    const connOptions = options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;

    for (let i = 0; i < connOptions.maxRetry + 1; i++) {
      try {
        const startTime = process.hrtime.bigint();
        const event = await this.#recognizeImpl(buffer, options.language, options.abortSignal);
        const durationMs = Number((process.hrtime.bigint() - startTime) / BigInt(1000000));
        this.emit('metrics_collected', {
          type: 'stt_metrics',
          requestId: event.requestId ?? '',
          timestamp: Date.now(),
          durationMs,
          label: this.label,
          audioDurationMs: Math.round(calculateAudioDurationSeconds(buffer) * 1000),
          streamed: false,
          metadata: {
            modelProvider: this.provider,
            modelName: this.model,
          },
        });
        return event;
      } catch (error) {
        if (error instanceof APIError) {
          const retryInterval = intervalForRetry(connOptions, i);

          if (connOptions.maxRetry === 0 || !error.retryable) {
            this.#emitError(error, false);
            throw error;
          } else if (i === connOptions.maxRetry) {
            this.#emitError(error, false);
            throw new APIConnectionError({
              message: `failed to recognize speech after ${connOptions.maxRetry + 1} attempts`,
              options: { retryable: false },
            });
          } else {
            this.#logger.warn(
              { stt: this.label, attempt: i + 1, error },
              `failed to recognize speech, retrying in ${retryInterval}ms`,
            );
          }

          if (retryInterval > 0) {
            await delay(retryInterval);
          }
        } else {
          throw error;
        }
      }
    }

    throw new APIConnectionError({ message: 'failed to recognize speech' });
  }

  protected async _recognize(
    buffer: AudioBuffer,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    return this.#recognizeImpl(buffer, undefined, abortSignal);
  }

  #emitError(error: Error, recoverable: boolean): void {
    this.emit('error', {
      type: 'stt_error',
      timestamp: Date.now(),
      label: this.label,
      error,
      recoverable,
    });
  }

  async #recognizeImpl(
    buffer: AudioBuffer,
    language?: string,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    if (language !== undefined) {
      this.#opts.languageCode = normalizeLanguage(language);
    }

    const wavBytes = createWav(mergeFrames(buffer));
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wavBytes)], { type: 'audio/x-wav' }), 'audio.wav');
    form.append('model_id', this.#opts.modelId);
    form.append('tag_audio_events', String(this.#opts.tagAudioEvents));
    if (this.#opts.languageCode) {
      form.append('language_code', this.#opts.languageCode);
    }
    if (this.#opts.keyterms !== undefined) {
      for (const keyterm of this.#opts.keyterms) {
        form.append('keyterms', keyterm);
      }
    }

    try {
      const fetchFn = this.#session.fetch ?? fetch;
      const response = await fetchFn(`${this.#opts.baseURL}/speech-to-text`, {
        method: 'POST',
        headers: { [AUTHORIZATION_HEADER]: this.#opts.apiKey },
        body: form,
        signal: abortSignal ?? null,
      });
      const responseJson = parseBatchResponse(await response.json());
      if (response.status !== 200) {
        throw new APIStatusError({
          message: responseJson.detail ?? 'Unknown ElevenLabs error',
          options: { statusCode: response.status, requestId: null, body: responseJson },
        });
      }

      const words = responseJson.words ?? [];
      const speakerId = words.length > 0 ? words[0]?.speaker_id ?? null : null;
      const startTime = words.length > 0 ? Math.min(...words.map((word) => word.start ?? 0)) : 0;
      const endTime = words.length > 0 ? Math.max(...words.map((word) => word.end ?? 0)) : 0;
      const normalizedLanguage = normalizeLanguage(
        responseJson.language_code ?? this.#opts.languageCode ?? '',
      );

      return this.#transcriptionToSpeechEvent(
        normalizedLanguage,
        responseJson.text ?? '',
        startTime,
        endTime,
        speakerId,
        words.length > 0 ? words : undefined,
      );
    } catch (error) {
      if (error instanceof APITimeoutError || error instanceof APIConnectionError) {
        throw error;
      }
      if (error instanceof APIStatusError) {
        throw new APIConnectionError({ message: error.message });
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new APITimeoutError({});
      }
      throw new APIConnectionError({});
    }
  }

  #transcriptionToSpeechEvent(
    languageCode: string,
    text: string,
    startTime: number,
    endTime: number,
    speakerId: string | null,
    words?: ElevenLabsWord[],
  ): stt.SpeechEvent {
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text,
          language: normalizeLanguage(languageCode),
          speakerId,
          startTime,
          endTime,
          confidence: 0,
          words: words?.map((word) =>
            createTimedString({
              text: word.text ?? '',
              startTime: word.start ?? 0,
              endTime: word.end ?? 0,
            }),
          ),
        },
      ],
    };
  }

  updateOptions(opts: {
    tagAudioEvents?: boolean;
    serverVad?: VADOptions | null;
    keyterms?: string[];
  }): void {
    if (opts.tagAudioEvents !== undefined) {
      this.#opts.tagAudioEvents = opts.tagAudioEvents;
    }

    if (opts.serverVad !== undefined) {
      this.#opts.serverVad = opts.serverVad;
    }

    if (opts.keyterms !== undefined) {
      this.#opts.keyterms = opts.keyterms;
    }

    for (const ref of this.#streams) {
      const stream = ref.deref();
      if (stream) {
        stream.updateOptions({ serverVad: opts.serverVad });
      } else {
        this.#streams.delete(ref);
      }
    }
  }

  stream(options?: { language?: string; connOptions?: APIConnectOptions }): SpeechStream {
    const stream = new SpeechStream(
      this,
      this.#opts,
      options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      options?.language !== undefined
        ? normalizeLanguage(options.language)
        : this.#opts.languageCode,
      this.#session,
    );
    this.#streams.add(new WeakRef(stream));
    return stream;
  }
}

export class SpeechStream extends stt.SpeechStream {
  #opts: ResolvedSTTOptions;
  #language?: string;
  #session: STTHTTPSession;
  #reconnectEvent = new Future<void>();
  #speaking = false;
  #audioDurationCollector: PeriodicCollector<number>;
  #logger = log();

  label = 'elevenlabs.SpeechStream';

  constructor(
    sttInstance: STT,
    opts: ResolvedSTTOptions,
    connOptions: APIConnectOptions,
    language: string | undefined,
    httpSession: STTHTTPSession,
  ) {
    super(sttInstance, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#language = language;
    this.#session = httpSession;
    this.#audioDurationCollector = new PeriodicCollector(
      (duration) => this.#onAudioDurationReport(duration),
      { duration: 5.0 },
    );
  }

  updateOptions(opts: { serverVad?: VADOptions | null }): void {
    if (opts.serverVad !== undefined) {
      this.#opts.serverVad = opts.serverVad;
      if (!this.#reconnectEvent.done) {
        this.#reconnectEvent.resolve();
      }
    }
  }

  #onAudioDurationReport(duration: number): void {
    this.queue.put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      recognitionUsage: { audioDuration: duration },
    });
  }

  protected async run(): Promise<void> {
    while (!this.closed && !this.input.closed) {
      let ws: WebSocket | null = null;
      let closingWs = false;
      const sessionController = new AbortController();

      try {
        ws = await this.#connectWs();

        const keepaliveTask = Task.from(async (controller) => {
          while (!controller.signal.aborted) {
            await Promise.race([delay(10000), waitForAbort(controller.signal)]);
            if (controller.signal.aborted || ws?.readyState !== WebSocket.OPEN) return;
            ws.send(
              JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: '',
                commit: false,
                sample_rate: this.#opts.sampleRate,
              }),
            );
          }
        }, sessionController);

        const sendTask = Task.from(async (controller) => {
          const samples50Ms = Math.floor(this.#opts.sampleRate / 20);
          const audioByteStream = new AudioByteStream(this.#opts.sampleRate, 1, samples50Ms);
          const abortPromise = waitForAbort(controller.signal);
          const streamAbortPromise = waitForAbort(this.abortSignal);
          let hasEnded = false;

          try {
            while (!this.closed) {
              const result = await Promise.race([
                this.input.next(),
                abortPromise,
                streamAbortPromise,
              ]);
              if (result === undefined) return;
              if (result.done) break;

              const data = result.value;
              let frames: AudioFrame[];
              if (data === SpeechStream.FLUSH_SENTINEL) {
                frames = audioByteStream.flush();
                hasEnded = true;
              } else {
                frames = audioByteStream.write(data.data);
              }

              for (const frame of frames) {
                this.#audioDurationCollector.push(frame.samplesPerChannel / frame.sampleRate);
                const audioBase64 = Buffer.from(
                  frame.data.buffer,
                  frame.data.byteOffset,
                  frame.data.byteLength,
                ).toString('base64');
                ws?.send(
                  JSON.stringify({
                    message_type: 'input_audio_chunk',
                    audio_base_64: audioBase64,
                    commit: false,
                    sample_rate: this.#opts.sampleRate,
                  }),
                );

                if (hasEnded) {
                  this.#audioDurationCollector.flush();
                  hasEnded = false;
                }
              }
            }
          } finally {
            closingWs = true;
          }
        }, sessionController);

        const recvTask = Task.from(async (controller) => {
          const receiveMessages = new Promise<void>((resolve, reject) => {
            const onMessage = (msg: RawData, isBinary: boolean) => {
              if (isBinary) {
                this.#logger.warn('unexpected ElevenLabs STT binary message');
                return;
              }
              try {
                this.#processStreamEvent(parseStreamEvent(JSON.parse(msg.toString())));
              } catch (error) {
                this.#logger.error({ error }, 'failed to process ElevenLabs STT message');
              }
            };
            const onClose = (code: number, reason: Buffer) => {
              sessionController.abort();
              if (closingWs || this.closed) {
                resolve();
                return;
              }
              reject(
                new APIStatusError({
                  message: 'ElevenLabs STT connection closed unexpectedly',
                  options: {
                    statusCode: code || -1,
                    body: { reason: reason.toString() },
                  },
                }),
              );
            };
            const onError = (error: Error) => {
              sessionController.abort();
              reject(new APIConnectionError({ message: error.message }));
            };
            ws?.on('message', onMessage);
            ws?.once('close', onClose);
            ws?.once('error', onError);
          });

          await Promise.race([receiveMessages, waitForAbort(controller.signal)]);
        }, sessionController);

        const runResult = await Promise.race([
          Promise.all([keepaliveTask.result, sendTask.result, recvTask.result]).then(
            () => 'done' as const,
          ),
          this.#reconnectEvent.await.then(() => 'reconnect' as const),
          waitForAbort(this.abortSignal).then(() => 'abort' as const),
        ]);

        if (runResult === 'reconnect') {
          this.#reconnectEvent = new Future<void>();
          continue;
        }
        break;
      } finally {
        closingWs = true;
        sessionController.abort();
        ws?.close();
      }
    }
  }

  async #connectWs(): Promise<WebSocket> {
    const commitStrategy = this.#opts.serverVad === null ? 'manual' : 'vad';
    const params = [
      `model_id=${this.#opts.modelId}`,
      `audio_format=pcm_${this.#opts.sampleRate}`,
      `commit_strategy=${commitStrategy}`,
    ];

    if (!this.#language) {
      params.push('include_language_detection=true');
    }

    if (this.#opts.serverVad) {
      if (
        this.#opts.serverVad.vadSilenceThresholdSecs !== undefined &&
        this.#opts.serverVad.vadSilenceThresholdSecs !== null
      ) {
        params.push(`vad_silence_threshold_secs=${this.#opts.serverVad.vadSilenceThresholdSecs}`);
      }
      if (
        this.#opts.serverVad.vadThreshold !== undefined &&
        this.#opts.serverVad.vadThreshold !== null
      ) {
        params.push(`vad_threshold=${this.#opts.serverVad.vadThreshold}`);
      }
      if (
        this.#opts.serverVad.minSpeechDurationMs !== undefined &&
        this.#opts.serverVad.minSpeechDurationMs !== null
      ) {
        params.push(`min_speech_duration_ms=${this.#opts.serverVad.minSpeechDurationMs}`);
      }
      if (
        this.#opts.serverVad.minSilenceDurationMs !== undefined &&
        this.#opts.serverVad.minSilenceDurationMs !== null
      ) {
        params.push(`min_silence_duration_ms=${this.#opts.serverVad.minSilenceDurationMs}`);
      }
    }

    if (this.#language) {
      params.push(`language_code=${this.#language}`);
    }

    if (this.#opts.includeTimestamps) {
      params.push('include_timestamps=true');
    }

    const baseURL = this.#opts.baseURL.replace('https://', 'wss://').replace('http://', 'ws://');
    const wsUrl = `${baseURL}/speech-to-text/realtime?${params.join('&')}`;
    const headers = { [AUTHORIZATION_HEADER]: this.#opts.apiKey };

    try {
      if (this.#session.wsConnect) {
        return await this.#session.wsConnect(wsUrl, {
          headers,
          signal: this.abortSignal,
          timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
        });
      }

      const ws = new WebSocket(wsUrl, { headers });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('connect timeout'));
        }, DEFAULT_API_CONNECT_OPTIONS.timeoutMs);
        const cleanup = () => {
          clearTimeout(timeout);
          this.abortSignal.removeEventListener('abort', onAbort);
          ws.off('open', onOpen);
          ws.off('error', onError);
          ws.off('close', onClose);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = (code: number) => {
          cleanup();
          reject(new Error(`WebSocket returned ${code}`));
        };
        const onAbort = () => {
          cleanup();
          ws.close();
          reject(new Error('aborted'));
        };
        ws.once('open', onOpen);
        ws.once('error', onError);
        ws.once('close', onClose);
        this.abortSignal.addEventListener('abort', onAbort, { once: true });
      });
      return ws;
    } catch (error) {
      throw new APIConnectionError({ message: 'Failed to connect to ElevenLabs' });
    }
  }

  #processStreamEvent(data: ElevenLabsStreamEvent): void {
    const messageType = data.message_type;
    const text = data.text ?? '';
    const words = data.words ?? [];
    const startTime = words.length > 0 ? words[0]?.start ?? 0 : 0;
    const endTime = words.length > 0 ? words[words.length - 1]?.end ?? 0 : 0;
    const languageCode = data.language_code ?? this.#language;
    const normalizedLanguage = languageCode
      ? normalizeLanguage(languageCode)
      : normalizeLanguage('en');

    const speechData: stt.SpeechData = {
      language: normalizedLanguage,
      text,
      startTime: startTime + this.startTimeOffset,
      endTime: endTime + this.startTimeOffset,
      confidence: 0,
    };
    if (words.length > 0) {
      speechData.words = words.map((word) =>
        createTimedString({
          text: word.text ?? '',
          startTime: (word.start ?? 0) + this.startTimeOffset,
          endTime: (word.end ?? 0) + this.startTimeOffset,
          startTimeOffset: this.startTimeOffset,
        }),
      );
    }

    if (messageType === 'partial_transcript') {
      this.#logger.debug({ data }, 'Received message type partial_transcript');
      if (text) {
        if (!this.#speaking) {
          this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
          this.#speaking = true;
        }
        this.queue.put({
          type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
          alternatives: [speechData],
        });
      }
    } else if (
      (messageType === 'committed_transcript' && !this.#opts.includeTimestamps) ||
      (messageType === 'committed_transcript_with_timestamps' && this.#opts.includeTimestamps)
    ) {
      if (text) {
        if (!this.#speaking) {
          this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
          this.#speaking = true;
        }
        this.queue.put({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          alternatives: [speechData],
        });
      } else if (this.#speaking) {
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
        this.#speaking = false;
      }
    } else if (messageType === 'committed_transcript') {
      return;
    } else if (messageType === 'session_started') {
      this.#logger.debug(`Session started with ID: ${data.session_id ?? 'unknown'}`);
    } else if (
      messageType === 'auth_error' ||
      messageType === 'quota_exceeded' ||
      messageType === 'transcriber_error' ||
      messageType === 'input_error' ||
      messageType === 'error'
    ) {
      const errorMsg = data.message ?? 'Unknown error';
      const detailsSuffix = data.details ? ` - ${data.details}` : '';
      this.#logger.error(`ElevenLabs STT error [${messageType}]: ${errorMsg}${detailsSuffix}`);
      throw new APIConnectionError({ message: `${messageType}: ${errorMsg}${detailsSuffix}` });
    } else if (
      messageType === 'committed_transcript_with_timestamps' &&
      !this.#opts.includeTimestamps
    ) {
      return;
    } else {
      this.#logger.warn(`ElevenLabs STT unknown message type: ${messageType}, data: ${data}`);
    }
  }
}
