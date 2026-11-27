// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  type AudioBuffer,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  asLanguageCode,
  log,
  stt,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { wsHeaders } from './api.js';

const SUPPORTED_SAMPLE_RATE = 24_000;
const DEFAULT_MODEL_ENDPOINT = 'wss://api.gradium.ai/api/speech/asr';
const DEFAULT_FRAME_SIZE = 1920;
const DEFAULT_DELAY_IN_TOKENS = 6;

export type STTEncoding = 'pcm_s16le';

/** Configuration for Gradium streaming speech recognition. */
export interface STTOptions {
  /** Gradium API key. Defaults to `GRADIUM_API_KEY`. */
  apiKey?: string;
  /** Gradium ASR websocket endpoint. Defaults to `GRADIUM_MODEL_ENDPOINT`. */
  modelEndpoint: string;
  modelName: string;
  sampleRate: number;
  encoding: STTEncoding;
  /** Audio buffering duration in milliseconds. */
  bufferSizeMs: number;
  temperature?: number;
  language: string;
  vadThreshold: number;
  vadBucket?: number;
  vadFlush: boolean;
}

/** Per-stream Gradium speech recognition options. */
export interface SpeechStreamOptions {
  language?: string;
  connOptions?: APIConnectOptions;
}

interface ResolvedSTTOptions extends STTOptions {
  apiKey: string;
}

interface ReadyMessage {
  type: 'ready';
  delay_in_tokens?: number;
  frame_size?: number;
}

interface TextMessage {
  type: 'text';
  text: string;
  start_s: number;
}

interface StepMessage {
  type: 'step';
  vad?: Array<{ inactivity_prob?: number }>;
}

type GradiumMessage = ReadyMessage | TextMessage | StepMessage | { type: string };

const defaultSTTOptions: Omit<ResolvedSTTOptions, 'apiKey'> = {
  modelEndpoint: process.env.GRADIUM_MODEL_ENDPOINT ?? DEFAULT_MODEL_ENDPOINT,
  modelName: 'default',
  sampleRate: SUPPORTED_SAMPLE_RATE,
  encoding: 'pcm_s16le',
  bufferSizeMs: 80,
  language: 'en',
  vadThreshold: 0.9,
  vadBucket: 2,
  vadFlush: true,
};

/** Gradium streaming speech-to-text client. */
export class STT extends stt.STT {
  #opts: ResolvedSTTOptions;
  label = 'gradium.STT';

  constructor(opts: Partial<STTOptions> = {}) {
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: false,
      diarization: false,
      keyterms: false,
    });

    const apiKey = opts.apiKey ?? process.env.GRADIUM_API_KEY;
    if (!apiKey) {
      throw new Error('Gradium API key is required. Pass apiKey or set GRADIUM_API_KEY');
    }

    const merged = { ...defaultSTTOptions, ...opts, apiKey };
    if (merged.sampleRate !== SUPPORTED_SAMPLE_RATE) {
      throw new Error(`Only ${SUPPORTED_SAMPLE_RATE}Hz sample rate is supported`);
    }
    if (merged.encoding !== 'pcm_s16le') {
      throw new Error('Only pcm_s16le encoding is supported');
    }
    this.#opts = merged;
  }

  override get model(): string {
    return this.#opts.modelName;
  }

  override get provider(): string {
    return 'Gradium';
  }

  protected override async _recognize(_buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new APIError('Gradium supports streaming recognition only', { retryable: false });
  }

  override stream(options: SpeechStreamOptions = {}): SpeechStream {
    return new SpeechStream(
      this,
      { ...this.#opts, language: options.language ?? this.#opts.language },
      options.connOptions,
    );
  }

  updateOptions(opts: Pick<Partial<STTOptions>, 'bufferSizeMs'>): void {
    this.#opts = { ...this.#opts, ...opts };
  }
}

/** A Gradium streaming speech recognition session. */
export class SpeechStream extends stt.SpeechStream {
  readonly #opts: ResolvedSTTOptions;
  readonly #timeoutMs: number;
  readonly #logger = log().child({ plugin: 'gradium' });
  #ws?: WebSocket;
  #ready?: ReadyMessage;
  #speaking = false;
  #bufferedText: string[] = [];
  #remainingVadSteps?: number;

  label = 'gradium.SpeechStream';

  constructor(sttInstance: STT, opts: ResolvedSTTOptions, connOptions?: APIConnectOptions) {
    super(sttInstance, opts.sampleRate, connOptions);
    this.#opts = opts;
    this.#timeoutMs = connOptions?.timeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.timeoutMs;
  }

  protected override async run(): Promise<void> {
    if (this.abortSignal.aborted) return;

    this.#speaking = false;
    this.#bufferedText = [];
    this.#remainingVadSteps = undefined;

    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort(this.abortSignal.reason);
    this.abortSignal.addEventListener('abort', abortAttempt, { once: true });
    let sender: Promise<void> | undefined;
    let receiver: Promise<void> | undefined;

    try {
      const ws = await this.#connect(attemptController.signal);
      this.#ws = ws;
      sender = this.#sendAudio(ws, attemptController.signal);
      receiver = this.#receive(ws, attemptController.signal);

      // Input completion does not end a Gradium session. Keep receiving final
      // provider events, while still propagating a sender failure immediately.
      const senderFailure = sender.then(
        () => new Promise<never>(() => {}),
        (error: unknown) => Promise.reject(error),
      );
      await Promise.race([receiver, senderFailure]);
      if (!this.abortSignal.aborted) {
        throw new APIConnectionError({
          message: 'Gradium connection closed unexpectedly',
          options: { retryable: true },
        });
      }
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) throw error;
      throw new APIConnectionError({
        message: `Gradium Speech-to-Text connection error: ${String(error)}`,
      });
    } finally {
      this.abortSignal.removeEventListener('abort', abortAttempt);
      attemptController.abort();
      this.#closeSocket();
      await Promise.allSettled([sender, receiver].filter((task): task is Promise<void> => !!task));
    }
  }

  async #connect(signal: AbortSignal): Promise<WebSocket> {
    const ws = new WebSocket(this.#opts.modelEndpoint, {
      handshakeTimeout: this.#timeoutMs,
      headers: wsHeaders(this.#opts.apiKey),
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          ws.off('open', onOpen);
          ws.off('unexpected-response', onUnexpectedResponse);
          ws.off('error', onError);
          ws.off('close', onClose);
          signal.removeEventListener('abort', onAbort);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
          cleanup();
          reject(
            new APIStatusError({
              message: 'Gradium websocket connection was rejected',
              options: { statusCode: response.statusCode ?? -1 },
            }),
          );
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = (code: number) => {
          cleanup();
          reject(
            new APIStatusError({
              message: 'Gradium websocket closed during connection',
              options: { statusCode: code || -1 },
            }),
          );
        };
        const onAbort = () => {
          cleanup();
          reject(signal.reason);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Gradium websocket connection timed out'));
        }, this.#timeoutMs);

        ws.once('open', onOpen);
        ws.once('unexpected-response', onUnexpectedResponse);
        ws.once('error', onError);
        ws.once('close', onClose);
        signal.addEventListener('abort', onAbort, { once: true });
      });

      ws.send(
        JSON.stringify({
          type: 'setup',
          model_name: this.#opts.modelName,
          input_format: 'pcm',
          json_config: {
            language: this.#opts.language,
            ...(this.#opts.temperature === undefined ? {} : { temp: this.#opts.temperature }),
          },
        }),
      );
      return ws;
    } catch (error) {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.once('error', () => {});
        ws.terminate();
      } else {
        ws.close();
      }
      throw error;
    }
  }

  async #sendAudio(ws: WebSocket, signal: AbortSignal): Promise<void> {
    const audio = new AudioByteStream(this.#opts.sampleRate, 1, DEFAULT_FRAME_SIZE);
    while (true) {
      let result: Awaited<ReturnType<typeof this.input.next>>;
      try {
        result = await this.input.next({ signal });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (result.done) return;

      const frames =
        result.value === SpeechStream.FLUSH_SENTINEL
          ? audio.flush()
          : audio.write(result.value.data);
      for (const frame of frames) this.#sendFrame(ws, frame.data);
    }
  }

  #sendFrame(ws: WebSocket, data: Int16Array): void {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    ws.send(JSON.stringify({ type: 'audio', audio: bytes.toString('base64') }));
  }

  #receive(ws: WebSocket, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onMessage = (raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.#logger.error('Unexpected binary message from Gradium');
          return;
        }
        try {
          this.#processMessage(JSON.parse(raw.toString()) as GradiumMessage);
        } catch (error) {
          this.#logger.error({ error }, 'Failed to process message from Gradium');
        }
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };

      ws.on('message', onMessage);
      ws.once('close', onClose);
      ws.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #processMessage(message: GradiumMessage): void {
    if (message.type === 'ready') {
      this.#ready = message as ReadyMessage;
      return;
    }
    if (message.type === 'text') {
      const text = message as TextMessage;
      if (!this.#speaking) {
        this.#speaking = true;
        this.#put({ type: stt.SpeechEventType.START_OF_SPEECH });
      }
      this.#bufferedText.push(text.text);
      this.#put({
        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives: [this.#speechData(text.text, text.start_s + this.startTimeOffset)],
      });
      return;
    }
    if (message.type !== 'step' || !this.#speaking || this.#opts.vadBucket === undefined) return;

    const step = message as StepMessage;
    const inactivity = step.vad?.[this.#opts.vadBucket]?.inactivity_prob;
    if (inactivity === undefined || inactivity <= this.#opts.vadThreshold) {
      this.#remainingVadSteps = undefined;
      return;
    }

    if (this.#remainingVadSteps === undefined) {
      this.#remainingVadSteps = this.#ready?.delay_in_tokens ?? DEFAULT_DELAY_IN_TOKENS;
      if (this.#opts.vadFlush) this.#flushVadDelay();
      return;
    }

    this.#remainingVadSteps -= 1;
    if (this.#remainingVadSteps > 0) return;

    this.#put({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [this.#speechData(this.#bufferedText.join(' '), 0)],
    });
    this.#put({ type: stt.SpeechEventType.END_OF_SPEECH });
    this.#speaking = false;
    this.#bufferedText = [];
    this.#remainingVadSteps = undefined;
  }

  #flushVadDelay(): void {
    const frameSize = this.#ready?.frame_size ?? DEFAULT_FRAME_SIZE;
    const delay = this.#ready?.delay_in_tokens ?? DEFAULT_DELAY_IN_TOKENS;
    const samples = frameSize * delay;
    if (!this.input.closed) {
      this.input.put(new AudioFrame(new Int16Array(samples), this.#opts.sampleRate, 1, samples));
    }
  }

  #speechData(text: string, startTime: number): stt.SpeechData {
    return {
      text,
      language: asLanguageCode(this.#opts.language),
      startTime,
      endTime: 0,
      confidence: 0,
    };
  }

  #put(event: stt.SpeechEvent): void {
    if (!this.queue.closed) this.queue.put(event);
  }

  #closeSocket(): void {
    if (this.#ws?.readyState === WebSocket.CONNECTING) {
      this.#ws.once('error', () => {});
      this.#ws.terminate();
    } else if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.close();
    }
  }

  override close(): void {
    this.#closeSocket();
    super.close();
  }
}
