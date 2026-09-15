// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LanguageCode } from '@livekit/agents';
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  createTimedString,
  mergeFrames,
  normalizeLanguage,
  stt,
  waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { IncomingMessage } from 'node:http';
import { type RawData, WebSocket } from 'ws';
import { resolveEndpoint } from './endpoint.js';

export const QWEN3_SAMPLE_RATE = 16000;
export const QWEN3_NUM_CHANNELS = 1;
const SAMPLES_PER_CHUNK = QWEN3_SAMPLE_RATE / 10;
const LANGUAGE_OVERRIDES: Record<string, string> = { cantonese: 'yue', filipino: 'fil' };

export interface Qwen3STTOptions {
  modelEndpoint?: string;
  modelId?: string;
  chainId?: string;
  apiKey?: string;
  language?: string;
  interimResults?: boolean;
  partialTranscriptIntervalS?: number;
  finalTranscriptMaxDurationS?: number;
  vadThreshold?: number;
  vadMinSilenceDurationMs?: number;
  vadSpeechPadMs?: number;
  wordTimestamps?: boolean;
}

interface ResolvedQwen3STTOptions {
  audioLanguage: string;
  enablePartialTranscripts: boolean;
  partialTranscriptIntervalS: number;
  finalTranscriptMaxDurationS: number;
  vadThreshold: number;
  vadMinSilenceDurationMs: number;
  vadSpeechPadMs: number;
  wordTimestamps: boolean;
}

interface Qwen3Word {
  word?: string;
  start_time?: number;
  end_time?: number;
  prob?: number;
}

interface Qwen3Segment {
  text?: string;
  start_time?: number;
  end_time?: number;
  word_timestamps?: Qwen3Word[];
}

interface Qwen3Event {
  type?: string;
  message?: string;
  segments?: Qwen3Segment[];
  is_final?: boolean;
  is_end_of_audio_flush?: boolean;
  language_code?: string;
}

interface InputState {
  ended: boolean;
  onEnded?: () => void;
}

function languageCode(name?: string): LanguageCode {
  if (!name) return normalizeLanguage('');
  const key = name.trim().toLowerCase();
  return normalizeLanguage(LANGUAGE_OVERRIDES[key] ?? key);
}

function handshake(opts: ResolvedQwen3STTOptions): Record<string, unknown> {
  return {
    whisper_params: {
      audio_language: opts.audioLanguage,
      show_word_timestamps: opts.wordTimestamps,
    },
    streaming_params: {
      enable_partial_transcripts: opts.enablePartialTranscripts,
      partial_transcript_interval_s: opts.partialTranscriptIntervalS,
      final_transcript_max_duration_s: opts.finalTranscriptMaxDurationS,
    },
    streaming_vad_config: {
      threshold: opts.vadThreshold,
      min_silence_duration_ms: opts.vadMinSilenceDurationMs,
      speech_pad_ms: opts.vadSpeechPadMs,
    },
  };
}

/** Connection settings for a Qwen3-ASR deployment, owned by the public Baseten STT. */
export class Qwen3Backend {
  readonly #apiKey: string;
  readonly #modelEndpoint: string;
  #opts: ResolvedQwen3STTOptions;

  constructor(opts: Qwen3STTOptions = {}) {
    const apiKey = opts.apiKey || process.env.BASETEN_API_KEY;
    if (!apiKey) throw new Error('Pass `apiKey` or set BASETEN_API_KEY.');

    this.#apiKey = apiKey;
    this.#modelEndpoint = resolveEndpoint(
      opts.modelEndpoint,
      opts.modelId,
      opts.chainId,
      'BASETEN_MODEL_ENDPOINT',
    );
    this.#opts = {
      audioLanguage: opts.language ?? 'auto',
      enablePartialTranscripts: opts.interimResults ?? true,
      partialTranscriptIntervalS: opts.partialTranscriptIntervalS ?? 0.5,
      finalTranscriptMaxDurationS: opts.finalTranscriptMaxDurationS ?? 30,
      vadThreshold: opts.vadThreshold ?? 0.5,
      vadMinSilenceDurationMs: opts.vadMinSilenceDurationMs ?? 500,
      vadSpeechPadMs: opts.vadSpeechPadMs ?? 100,
      wordTimestamps: opts.wordTimestamps ?? false,
    };
  }

  /** Applies to streams opened after this call because the options are sent per socket. */
  updateOptions(
    opts: Pick<
      Qwen3STTOptions,
      | 'language'
      | 'vadThreshold'
      | 'vadMinSilenceDurationMs'
      | 'vadSpeechPadMs'
      | 'partialTranscriptIntervalS'
    >,
  ): void {
    if (opts.language !== undefined) this.#opts.audioLanguage = opts.language;
    if (opts.vadThreshold !== undefined) this.#opts.vadThreshold = opts.vadThreshold;
    if (opts.vadMinSilenceDurationMs !== undefined) {
      this.#opts.vadMinSilenceDurationMs = opts.vadMinSilenceDurationMs;
    }
    if (opts.vadSpeechPadMs !== undefined) this.#opts.vadSpeechPadMs = opts.vadSpeechPadMs;
    if (opts.partialTranscriptIntervalS !== undefined) {
      this.#opts.partialTranscriptIntervalS = opts.partialTranscriptIntervalS;
    }
  }

  makeStream(
    owner: stt.STT,
    options: { language?: string; connOptions?: APIConnectOptions } = {},
  ): Qwen3SpeechStream {
    const streamOpts = { ...this.#opts };
    if (options.language !== undefined) streamOpts.audioLanguage = options.language;
    return new Qwen3SpeechStream(
      owner,
      this.#apiKey,
      this.#modelEndpoint,
      streamOpts,
      options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    );
  }

  /** Run one-shot recognition over the Qwen3 streaming protocol. */
  async recognizeViaStream(
    owner: stt.STT,
    buffer: AudioBuffer,
    options: {
      language?: string;
      connOptions?: APIConnectOptions;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<stt.SpeechEvent> {
    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason instanceof Error
        ? options.abortSignal.reason
        : new DOMException('The operation was aborted', 'AbortError');
    }
    const stream = this.makeStream(owner, options);
    const onAbort = () => stream.close();
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const texts: string[] = [];
    let language = languageCode();
    try {
      stream.pushFrame(mergeFrames(buffer));
      stream.flush();
      stream.endInput();
      for await (const event of stream) {
        if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT && event.alternatives?.length) {
          texts.push(event.alternatives[0].text);
          language = event.alternatives[0].language || language;
        }
      }
      if (stream.error) throw stream.error;
      if (options.abortSignal?.aborted) {
        throw options.abortSignal.reason instanceof Error
          ? options.abortSignal.reason
          : new DOMException('The operation was aborted', 'AbortError');
      }
    } finally {
      options.abortSignal?.removeEventListener('abort', onAbort);
      stream.close();
    }

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          language,
          text: texts.join(' ').trim(),
          startTime: 0,
          endTime: 0,
          confidence: 0,
        },
      ],
    };
  }
}

/** A single Qwen3-ASR recognition session. */
export class Qwen3SpeechStream extends stt.SpeechStream {
  readonly #apiKey: string;
  readonly #modelEndpoint: string;
  readonly #opts: ResolvedQwen3STTOptions;
  readonly #connOptions: APIConnectOptions;
  #error?: Error;
  label = 'baseten.Qwen3SpeechStream';

  get error(): Error | undefined {
    return this.#error;
  }

  constructor(
    owner: stt.STT,
    apiKey: string,
    modelEndpoint: string,
    opts: ResolvedQwen3STTOptions,
    connOptions: APIConnectOptions,
  ) {
    super(owner, QWEN3_SAMPLE_RATE, connOptions);
    this.#apiKey = apiKey;
    this.#modelEndpoint = modelEndpoint;
    this.#opts = opts;
    this.#connOptions = connOptions;
  }

  protected async run(): Promise<void> {
    this.#error = undefined;
    let ws: WebSocket | undefined;
    const sessionController = new AbortController();
    try {
      ws = await connectWebSocket(
        this.#modelEndpoint,
        this.#apiKey,
        this.#connOptions.timeoutMs,
        this.abortSignal,
      );
      await sendWebSocket(ws, JSON.stringify(handshake(this.#opts)));

      const inputState: InputState = { ended: false };
      await Promise.race([
        Promise.all([
          this.#sendAudio(ws, inputState, sessionController.signal),
          this.#receiveEvents(ws, inputState, sessionController.signal),
        ]),
        waitForAbort(this.abortSignal),
      ]);
    } catch (error) {
      if (
        error instanceof APIConnectionError ||
        error instanceof APIStatusError ||
        error instanceof APITimeoutError
      ) {
        this.#error = error;
        throw error;
      }
      this.#error = new APIConnectionError({
        message: error instanceof Error ? error.message : 'Baseten STT connection failed',
      });
      throw this.#error;
    } finally {
      sessionController.abort();
      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }

  async #sendAudio(
    ws: WebSocket,
    inputState: InputState,
    sessionSignal: AbortSignal,
  ): Promise<void> {
    const chunker = new AudioByteStream(QWEN3_SAMPLE_RATE, QWEN3_NUM_CHANNELS, SAMPLES_PER_CHUNK);
    const abortPromise = waitForAbort(AbortSignal.any([this.abortSignal, sessionSignal]));
    let committed = false;

    const append = async (frames: AudioFrame[]) => {
      for (const frame of frames) {
        const audio = Buffer.from(
          frame.data.buffer,
          frame.data.byteOffset,
          frame.data.byteLength,
        ).toString('base64');
        await sendWebSocket(ws, JSON.stringify({ type: 'input_audio_buffer.append', audio }));
      }
    };
    const commit = () => sendWebSocket(ws, JSON.stringify({ type: 'input_audio_buffer.commit' }));

    try {
      while (!this.closed) {
        const result = await Promise.race([this.input.next(), abortPromise]);
        if (result === undefined) return;
        if (result.done) break;

        const data = result.value;
        if (data === Qwen3SpeechStream.FLUSH_SENTINEL) {
          await append(chunker.flush());
          await commit();
          committed = true;
        } else {
          if (data.sampleRate !== QWEN3_SAMPLE_RATE || data.channels !== QWEN3_NUM_CHANNELS) {
            throw new APIConnectionError({
              message: `expected ${QWEN3_SAMPLE_RATE}Hz mono audio, got ${data.sampleRate}Hz/${data.channels}ch`,
              options: { retryable: false },
            });
          }
          await append(chunker.write(data.data));
          committed = false;
        }
      }

      if (!committed) {
        await append(chunker.flush());
        await commit();
      }
    } finally {
      inputState.ended = true;
      inputState.onEnded?.();
    }
  }

  #receiveEvents(ws: WebSocket, inputState: InputState, sessionSignal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let speaking = false;

      const cleanup = () => {
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        sessionSignal.removeEventListener('abort', onAbort);
        inputState.onEnded = undefined;
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => finish();
      const onClose = () => {
        if (inputState.ended || this.closed) finish();
        else fail(new APIConnectionError({ message: 'Baseten closed the STT websocket' }));
      };
      const onError = (error: Error) =>
        fail(new APIConnectionError({ message: `websocket error: ${error.message}` }));
      const onMessage = (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        try {
          const event = JSON.parse(data.toString()) as Qwen3Event;
          if (event.type === 'error') {
            fail(
              new APIStatusError({
                message: event.message ?? 'unknown STT error',
                options: { statusCode: 500 },
              }),
            );
            return;
          }
          if (event.type !== 'transcription') return;

          const segments = event.segments ?? [];
          const text = segments
            .map((segment) => segment.text ?? '')
            .join(' ')
            .trim();
          const isFinal = Boolean(event.is_final);

          if (!speaking && text) {
            speaking = true;
            this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
          }
          if (text) {
            this.queue.put({
              type: isFinal
                ? stt.SpeechEventType.FINAL_TRANSCRIPT
                : stt.SpeechEventType.INTERIM_TRANSCRIPT,
              alternatives: [this.#speechData(event, segments, text)],
            });
          }
          if (isFinal) {
            if (speaking) {
              this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
              speaking = false;
            }
            if (event.is_end_of_audio_flush) {
              if (inputState.ended) finish();
              else inputState.onEnded = finish;
            }
          }
        } catch (error) {
          fail(
            error instanceof APIStatusError
              ? error
              : new APIConnectionError({
                  message: error instanceof Error ? error.message : 'invalid Baseten STT message',
                }),
          );
        }
      };

      ws.on('message', onMessage);
      ws.once('close', onClose);
      ws.once('error', onError);
      sessionSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #speechData(event: Qwen3Event, segments: Qwen3Segment[], text: string): stt.SpeechData {
    const words = this.#opts.wordTimestamps
      ? segments.flatMap((segment) =>
          (segment.word_timestamps ?? []).map((word) =>
            createTimedString({
              text: word.word ?? '',
              startTime: (word.start_time ?? 0) + this.startTimeOffset,
              endTime: (word.end_time ?? 0) + this.startTimeOffset,
              confidence: word.prob ?? 0,
              startTimeOffset: this.startTimeOffset,
            }),
          ),
        )
      : [];

    return {
      language: languageCode(event.language_code),
      text,
      startTime: (segments[0]?.start_time ?? 0) + this.startTimeOffset,
      endTime: (segments.at(-1)?.end_time ?? 0) + this.startTimeOffset,
      confidence: 1,
      words: words.length ? words : undefined,
    };
  }
}

async function sendWebSocket(ws: WebSocket, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.send(data, (error) => (error ? reject(error) : resolve()));
  });
}

async function connectWebSocket(
  endpoint: string,
  apiKey: string,
  timeoutMs: number,
  abortSignal: AbortSignal,
): Promise<WebSocket> {
  const ws = new WebSocket(endpoint, {
    headers: { Authorization: `Api-Key ${apiKey}` },
  });

  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onClose);
      ws.off('unexpected-response', onUnexpectedResponse);
      abortSignal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.terminate();
      reject(error);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    };
    const onError = (error: Error) => fail(new APIConnectionError({ message: error.message }));
    const onClose = (code: number, reason: Buffer) =>
      fail(
        new APIConnectionError({
          message: `WebSocket closed before open (code=${code}, reason=${reason.toString()})`,
        }),
      );
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) =>
      fail(
        new APIStatusError({
          message: response.statusMessage ?? 'Baseten rejected the WebSocket connection',
          options: { statusCode: response.statusCode ?? -1 },
        }),
      );
    const onAbort = () => fail(new APIConnectionError({ message: 'WebSocket connection aborted' }));
    const timer =
      timeoutMs > 0
        ? setTimeout(
            () =>
              fail(new APITimeoutError({ message: 'Baseten STT WebSocket connection timed out' })),
            timeoutMs,
          )
        : undefined;

    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('close', onClose);
    ws.once('unexpected-response', onUnexpectedResponse);
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) {
      onAbort();
      return;
    }
  });
}
