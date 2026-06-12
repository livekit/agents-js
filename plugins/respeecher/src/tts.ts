// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import type { TTSEncoding, TTSModels, Voice, VoiceSettings } from './models.js';

const API_AUTH_HEADER = 'X-API-Key';
const API_VERSION_HEADER = 'LiveKit-Plugin-Respeecher-Version';
const API_BASE_URL = 'https://api.respeecher.com/v1';
const NUM_CHANNELS = 1;

const DEFAULT_VOICES: Record<string, string> = {
  '/public/tts/en-rt': 'samantha',
  '/public/tts/ua-rt': 'olesia-conversation',
};

interface ResolvedTTSOptions {
  model: TTSModels | string;
  encoding: TTSEncoding;
  sampleRate: number;
  voiceId: string;
  voiceSettings?: VoiceSettings;
  apiKey: string;
  baseURL: string;
  sentenceTokenizer: tokenize.SentenceTokenizer;
}

/** @public */
export interface TTSOptions {
  /** ID of the voice to use. Defaults to a model-specific public voice where available. */
  voiceId?: string;
  /** Respeecher API key. Defaults to $RESPEECHER_API_KEY. */
  apiKey?: string;
  /** Respeecher TTS model to use. */
  model?: TTSModels | string;
  /** Audio encoding format. */
  encoding?: TTSEncoding;
  /** Optional voice settings including sampling parameters. */
  voiceSettings?: VoiceSettings;
  /** Output audio sample rate in Hz. */
  sampleRate?: number;
  /** Sentence tokenizer for streaming synthesis. */
  sentenceTokenizer?: tokenize.SentenceTokenizer;
  /** Base URL for the Respeecher API. */
  baseURL?: string;
}

/** @public */
export interface ListVoicesOptions {
  /** Respeecher TTS model whose voices should be listed. */
  model?: TTSModels | string;
  /** Respeecher API key. Defaults to $RESPEECHER_API_KEY. */
  apiKey?: string;
  /** Base URL for the Respeecher API. */
  baseURL?: string;
}

const defaultTTSOptions = {
  model: '/public/tts/en-rt' as const,
  encoding: 'pcm_s16le' as const,
  sampleRate: 24000,
  baseURL: API_BASE_URL,
};

function resolveOptions(opts: Partial<TTSOptions>): ResolvedTTSOptions {
  const apiKey = opts.apiKey ?? process.env.RESPEECHER_API_KEY;
  if (!apiKey) {
    throw new Error('RESPEECHER_API_KEY must be set');
  }

  const model = opts.model ?? defaultTTSOptions.model;
  const voiceId = opts.voiceId ?? DEFAULT_VOICES[model];
  if (!voiceId) {
    throw new Error(
      `voiceId is required for model ${JSON.stringify(model)} (no default voice is configured); ` +
        'pass voiceId explicitly or use one of the supported models.',
    );
  }

  return {
    model,
    encoding: opts.encoding ?? defaultTTSOptions.encoding,
    sampleRate: opts.sampleRate ?? defaultTTSOptions.sampleRate,
    voiceId,
    voiceSettings: opts.voiceSettings,
    apiKey,
    baseURL: opts.baseURL ?? defaultTTSOptions.baseURL,
    sentenceTokenizer: opts.sentenceTokenizer ?? new tokenize.basic.SentenceTokenizer(),
  };
}

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    [API_AUTH_HEADER]: apiKey,
    [API_VERSION_HEADER]: __PACKAGE_VERSION__,
  };
}

async function statusError(response: Response, message: string): Promise<APIStatusError> {
  const body = await response.text().catch(() => '');
  return new APIStatusError({
    message: `${message}: ${response.status} ${response.statusText}${body ? ` ${body}` : ''}`,
    options: {
      statusCode: response.status,
      body: body ? { body } : null,
    },
  });
}

function voicePayload(opts: ResolvedTTSOptions): Record<string, unknown> {
  const voice: Record<string, unknown> = { id: opts.voiceId };
  if (opts.voiceSettings?.samplingParams) {
    voice.sampling_params = opts.voiceSettings.samplingParams;
  }
  return voice;
}

function requestPayload(text: string, opts: ResolvedTTSOptions): Record<string, unknown> {
  return {
    transcript: text,
    voice: voicePayload(opts),
    output_format: {
      sample_rate: opts.sampleRate,
      encoding: opts.encoding,
    },
  };
}

function stripWavHeader(data: Buffer): Buffer {
  if (data.length >= 44 && data.subarray(0, 4).toString('ascii') === 'RIFF') {
    return data.subarray(44);
  }
  return data;
}

function createTimeoutSignal(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  parent.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

function wsUrl(opts: ResolvedTTSOptions): string {
  const baseURL = opts.baseURL.replace('https://', 'wss://').replace('http://', 'ws://');
  if (!baseURL.startsWith('wss://')) {
    throw new APIConnectionError({ message: 'Secure WebSocket connection (wss://) required' });
  }

  const params = new URLSearchParams({
    api_key: opts.apiKey,
    source: API_VERSION_HEADER,
    version: __PACKAGE_VERSION__,
  });
  return `${baseURL}${opts.model}/tts/websocket?${params.toString()}`;
}

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(new APITimeoutError({ message: 'Respeecher WebSocket connection timed out' }));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
      ws.removeListener('close', onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new APIConnectionError({ message: `Respeecher WebSocket error: ${error.message}` }));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(
        new APIStatusError({
          message: `Respeecher WebSocket closed during connect: ${code} ${reason.toString()}`,
        }),
      );
    };

    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

function sendWsJson(ws: WebSocket, payload: unknown, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  if (ws.readyState !== WebSocket.OPEN) {
    throw new APIConnectionError({ message: 'Respeecher WebSocket is closed' });
  }

  return new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(payload), (error) => {
      if (!error || signal.aborted) {
        resolve();
        return;
      }
      reject(
        new APIConnectionError({ message: `Respeecher WebSocket send error: ${error.message}` }),
      );
    });
  });
}

function sendLastFrame(
  queue: { put: (item: tts.SynthesizedAudio) => void; closed: boolean },
  requestId: string,
  segmentId: string,
  frame: AudioFrame | undefined,
  final: boolean,
): undefined {
  if (frame && !queue.closed) {
    queue.put({ requestId, segmentId, frame, final });
  }
  return undefined;
}

/**
 * List available voices for a Respeecher model.
 * @public
 */
export async function listVoices(opts: ListVoicesOptions = {}): Promise<Voice[]> {
  const apiKey = opts.apiKey ?? process.env.RESPEECHER_API_KEY;
  if (!apiKey) {
    throw new Error('RESPEECHER_API_KEY must be set');
  }

  const model = opts.model ?? defaultTTSOptions.model;
  const baseURL = opts.baseURL ?? defaultTTSOptions.baseURL;
  const response = await fetch(`${baseURL}${model}/voices`, {
    headers: apiHeaders(apiKey),
  });

  if (!response.ok) {
    throw await statusError(response, 'Respeecher list voices request failed');
  }

  const voices = (await response.json()) as Voice[];
  if (voices.length === 0) {
    throw new APIError('No voices are available');
  }
  for (const voice of voices) {
    if (!voice.id) {
      throw new Error("Voice must have an 'id' field");
    }
  }
  return voices;
}

/** @public */
export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  label = 'respeecher.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts = resolveOptions(opts);
    super(resolvedOpts.sampleRate, NUM_CHANNELS, {
      streaming: true,
      alignedTranscript: false,
    });
    this.#opts = resolvedOpts;
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Respeecher';
  }

  /** Update TTS options after initialization. */
  updateOptions(opts: Partial<Pick<TTSOptions, 'voiceId' | 'voiceSettings' | 'model'>>) {
    this.#opts = resolveOptions({ ...this.#opts, ...opts });
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts, options?.connOptions);
  }
}

/** @public */
export class ChunkedStream extends tts.ChunkedStream {
  #opts: ResolvedTTSOptions;
  #connOptions: APIConnectOptions;
  label = 'respeecher.ChunkedStream';

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#opts = resolveOptions(opts);
    this.#connOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
  }

  protected async run() {
    const requestId = shortuuid();
    const timeout = createTimeoutSignal(this.abortSignal, this.#connOptions.timeoutMs);

    try {
      const response = await fetch(`${this.#opts.baseURL}${this.#opts.model}/tts/bytes`, {
        method: 'POST',
        headers: {
          ...apiHeaders(this.#opts.apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestPayload(this.inputText, this.#opts)),
        signal: timeout.signal,
      });

      if (!response.ok) {
        throw await statusError(response, 'Respeecher TTS request failed');
      }

      const audio = stripWavHeader(Buffer.from(await response.arrayBuffer()));
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
      const frames = [...bstream.write(audio), ...bstream.flush()];
      let lastFrame: AudioFrame | undefined;

      for (const frame of frames) {
        lastFrame = sendLastFrame(this.queue, requestId, requestId, lastFrame, false);
        lastFrame = frame;
      }
      sendLastFrame(this.queue, requestId, requestId, lastFrame, true);
    } catch (error) {
      if (timeout.timedOut()) {
        throw new APITimeoutError({ message: 'Respeecher TTS request timed out' });
      }
      if (error instanceof APIError) throw error;
      throw new APIConnectionError({ message: `Respeecher TTS request failed: ${error}` });
    } finally {
      timeout.cleanup();
      this.queue.close();
    }
  }
}

/** @public */
export class SynthesizeStream extends tts.SynthesizeStream {
  #logger = log();
  #opts: ResolvedTTSOptions;
  #tokenizer: tokenize.SentenceStream;
  #websocket: WebSocket | null = null;
  label = 'respeecher.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = resolveOptions(opts);
    this.#tokenizer = this.#opts.sentenceTokenizer.stream();
  }

  protected async run() {
    const contextId = shortuuid();
    const ws = new WebSocket(wsUrl(this.#opts));
    this.#websocket = ws;

    const onAbort = () => ws.close();
    this.abortController.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await waitForOpen(ws, this.connOptions.timeoutMs);

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
        const outputFormat = {
          encoding: this.#opts.encoding,
          sample_rate: this.#opts.sampleRate,
        };

        for await (const sentence of this.#tokenizer) {
          await sendWsJson(
            ws,
            {
              context_id: contextId,
              transcript: sentence.token || ' ',
              voice: voicePayload(this.#opts),
              continue: true,
              output_format: outputFormat,
            },
            this.abortController.signal,
          );
        }

        await sendWsJson(
          ws,
          {
            context_id: contextId,
            transcript: ' ',
            voice: voicePayload(this.#opts),
            continue: false,
            output_format: outputFormat,
          },
          this.abortController.signal,
        );
      };

      const recvTask = async () => {
        const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
        let inputEnded = false;
        let lastFrame: AudioFrame | undefined;

        const markInputEnded = sendTask().then(() => {
          inputEnded = true;
        });

        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            ws.removeListener('message', onMessage);
            ws.removeListener('error', onError);
            ws.removeListener('close', onClose);
          };
          const finish = () => {
            for (const frame of bstream.flush()) {
              lastFrame = sendLastFrame(this.queue, contextId, contextId, lastFrame, false);
              lastFrame = frame;
            }
            sendLastFrame(this.queue, contextId, contextId, lastFrame, true);
            if (!this.queue.closed) this.queue.put(SynthesizeStream.END_OF_STREAM);
            cleanup();
            resolve();
          };
          const onMessage = (data: RawData) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(data.toString()) as Record<string, unknown>;
            } catch (error) {
              reject(new APIConnectionError({ message: `Invalid Respeecher message: ${error}` }));
              return;
            }

            if (msg.context_id !== contextId) {
              this.#logger.warn(
                { contextId: msg.context_id, expectedContextId: contextId },
                'Received Respeecher message for unexpected context',
              );
              return;
            }

            if (msg.type === 'error') {
              reject(new APIError(`Respeecher returned error: ${String(msg.error)}`));
              return;
            }

            if (msg.type === 'chunk') {
              const chunk = typeof msg.data === 'string' ? Buffer.from(msg.data, 'base64') : null;
              if (chunk) {
                for (const frame of bstream.write(chunk)) {
                  lastFrame = sendLastFrame(this.queue, contextId, contextId, lastFrame, false);
                  lastFrame = frame;
                }
              }
              return;
            }

            if (msg.type === 'done' && inputEnded) {
              finish();
            }
          };
          const onError = (error: Error) => {
            cleanup();
            reject(
              new APIConnectionError({ message: `Respeecher WebSocket error: ${error.message}` }),
            );
          };
          const onClose = (code: number, reason: Buffer) => {
            cleanup();
            reject(
              new APIStatusError({
                message: `Respeecher connection closed unexpectedly: ${code} ${reason.toString()}`,
              }),
            );
          };

          ws.on('message', onMessage);
          ws.on('error', onError);
          ws.on('close', onClose);
        });

        await markInputEnded;
      };

      await Promise.all([inputTask(), recvTask()]);
    } catch (error) {
      if (error instanceof APIError) throw error;
      throw new APIConnectionError({ message: `failed to connect to Respeecher: ${error}` });
    } finally {
      this.abortController.signal.removeEventListener('abort', onAbort);
      this.#tokenizer.close();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      this.#websocket = null;
    }
  }

  override close(): void {
    this.#websocket?.close();
    this.#websocket = null;
    this.#tokenizer.close();
    super.close();
  }
}
