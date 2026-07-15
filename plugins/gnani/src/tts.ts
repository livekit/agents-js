// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  log,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

export const GNANI_TTS_BASE_URL = 'https://api.vachana.ai';

/** @public */
export type GnaniTTSVoices = 'Karan' | 'Simran' | 'Nara' | 'Riya' | 'Viraj' | 'Raju';
/** @public */
export type GnaniTTSEncodings = 'linear_pcm' | 'oggopus';
/** @public */
export type GnaniTTSContainers = 'raw' | 'mp3' | 'wav' | 'mulaw' | 'ogg';
/** @public */
export type GnaniTTSBitrates = '96k' | '128k' | '192k';
/** @public */
export type GnaniTTSSynthesizeMethod = 'rest' | 'sse' | 'websocket';

export const SUPPORTED_VOICES = new Set<string>([
  'Karan',
  'Simran',
  'Nara',
  'Riya',
  'Viraj',
  'Raju',
]);
export const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 44100] as const;

const WAV_HEADER_SIZE = 44;
const DEFAULT_SAMPLE_WIDTH = 2;
const DEPRECATED_TTS_OPTIONS = new Set(['language', 'httpSession', 'http_session']);

/** @public */
export interface TTSOptions {
  /** Voice to use for synthesis. Default: `Karan`. */
  voice?: GnaniTTSVoices | string;
  /** TTS model name. Default: `vachana-voice-v3`. */
  model?: string;
  /** Audio output sample rate. Default: 16000. */
  sampleRate?: number;
  /** Number of audio channels. Default: 1. */
  numChannels?: number;
  /** Audio encoding. Default: `linear_pcm`. */
  encoding?: GnaniTTSEncodings | string;
  /** Audio container. Default: `wav`. */
  container?: GnaniTTSContainers | string;
  /** Optional audio bitrate. */
  bitrate?: GnaniTTSBitrates | string;
  /** Gnani API key. Defaults to `$GNANI_API_KEY`. */
  apiKey?: string;
  /** Vachana API base URL. */
  baseURL?: string;
  /** Synthesis transport used by `synthesize()`. Default: `rest`. */
  synthesizeMethod?: GnaniTTSSynthesizeMethod;
}

interface ResolvedTTSOptions {
  apiKey: string;
  voice: string;
  model: string;
  sampleRate: number;
  encoding: string;
  container: string;
  numChannels: number;
  sampleWidth: number;
  bitrate?: string;
  baseURL: string;
  synthesizeMethod: GnaniTTSSynthesizeMethod;
}

function warnDeprecatedOptions(opts: Record<string, unknown>, caller: string) {
  for (const name of DEPRECATED_TTS_OPTIONS) {
    if (name in opts) {
      log().warn(`\`${name}\` is deprecated and no longer used by ${caller}`);
    }
  }
}

function resolveOptions(opts: TTSOptions & Record<string, unknown>): ResolvedTTSOptions {
  warnDeprecatedOptions(opts, 'TTS');

  const apiKey = opts.apiKey ?? process.env.GNANI_API_KEY;
  if (!apiKey) {
    throw new Error('Gnani API key is required. Provide it directly or set GNANI_API_KEY.');
  }

  const sampleRate = opts.sampleRate ?? 16000;
  if (!SUPPORTED_SAMPLE_RATES.includes(sampleRate as (typeof SUPPORTED_SAMPLE_RATES)[number])) {
    throw new Error(`sampleRate must be one of ${SUPPORTED_SAMPLE_RATES.join(', ')}`);
  }

  const voice = opts.voice ?? 'Karan';
  if (!SUPPORTED_VOICES.has(voice)) {
    throw new Error(
      `Voice '${voice}' not supported. Supported voices: ${[...SUPPORTED_VOICES].sort().join(', ')}`,
    );
  }

  const encoding = opts.encoding ?? 'linear_pcm';
  const container = opts.container ?? 'wav';
  if (encoding !== 'linear_pcm' || (container !== 'raw' && container !== 'wav')) {
    throw new Error(
      `Unsupported audio format: encoding=${encoding}, container=${container}. ` +
        'Gnani TTS currently decodes only linear_pcm in raw or wav containers.',
    );
  }

  return {
    apiKey,
    voice,
    model: opts.model ?? 'vachana-voice-v3',
    sampleRate,
    encoding,
    container,
    numChannels: opts.numChannels ?? 1,
    sampleWidth: DEFAULT_SAMPLE_WIDTH,
    bitrate: opts.bitrate,
    baseURL: opts.baseURL ?? GNANI_TTS_BASE_URL,
    synthesizeMethod: opts.synthesizeMethod ?? 'rest',
  };
}

function websocketURL(baseURL: string, path: string): string {
  if (baseURL.startsWith('https://')) return `wss://${baseURL.slice('https://'.length)}${path}`;
  if (baseURL.startsWith('http://')) return `ws://${baseURL.slice('http://'.length)}${path}`;
  return `wss://${baseURL}${path}`;
}

function buildPayload(opts: ResolvedTTSOptions, text: string): Record<string, unknown> {
  const audioConfig: Record<string, unknown> = {
    sample_rate: opts.sampleRate,
    encoding: opts.encoding,
    num_channels: opts.numChannels,
    sample_width: opts.sampleWidth,
    container: opts.container,
  };
  if (opts.bitrate != null) {
    audioConfig.bitrate = opts.bitrate;
  }

  return {
    text,
    voice: opts.voice,
    model: opts.model,
    audio_config: audioConfig,
  };
}

function buildHeaders(opts: ResolvedTTSOptions): Record<string, string> {
  return {
    'X-API-Key-ID': opts.apiKey,
    'Content-Type': 'application/json',
  };
}

function stripWavHeader(data: Buffer): Buffer {
  if (
    data.length > WAV_HEADER_SIZE &&
    data.subarray(0, 4).toString() === 'RIFF' &&
    data.subarray(8, 12).toString() === 'WAVE'
  ) {
    return data.subarray(WAV_HEADER_SIZE);
  }
  return data;
}

function decodeAudioChunk(data: Buffer, opts: ResolvedTTSOptions): Buffer {
  return opts.container === 'wav' ? stripWavHeader(data) : data;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function framesFromAudio(data: Buffer, opts: ResolvedTTSOptions): AudioFrame[] {
  const stream = new AudioByteStream(opts.sampleRate, opts.numChannels);
  return [...stream.write(data), ...stream.flush()];
}

function putFrames(
  queue: { put: (audio: tts.SynthesizedAudio) => void },
  frames: AudioFrame[],
  requestId: string,
  segmentId: string,
  final = true,
) {
  for (const [index, frame] of frames.entries()) {
    queue.put({ requestId, segmentId, frame, final: final && index === frames.length - 1 });
  }
}

class IncrementalAudioEmitter {
  private readonly stream: AudioByteStream;

  constructor(
    private readonly queue: { put: (audio: tts.SynthesizedAudio) => void },
    private readonly opts: ResolvedTTSOptions,
    private readonly requestId: string,
    private readonly segmentId: string,
  ) {
    this.stream = new AudioByteStream(opts.sampleRate, opts.numChannels);
  }

  push(data: Buffer) {
    putFrames(this.queue, this.stream.write(data), this.requestId, this.segmentId, false);
  }

  flush() {
    putFrames(this.queue, this.stream.flush(), this.requestId, this.segmentId);
  }
}

function apiError(message: string, statusCode = 500): APIStatusError {
  return new APIStatusError({
    message,
    options: { statusCode, body: { error: message } },
  });
}

function mapWebSocketError(error: Error): APIConnectionError {
  if (/timed? out|timeout/i.test(error.message)) {
    return new APITimeoutError({
      message: `Gnani TTS WebSocket connection timed out: ${error.message}`,
    });
  }
  return new APIConnectionError({ message: `Gnani TTS WebSocket error: ${error.message}` });
}

/** @public */
export class TTS extends tts.TTS {
  _opts: ResolvedTTSOptions;
  label = 'gnani.TTS';

  /** Create a new Gnani Vachana Text-to-Speech instance. */
  constructor(opts: TTSOptions & Record<string, unknown> = {}) {
    const resolved = resolveOptions(opts);
    super(resolved.sampleRate, resolved.numChannels, { streaming: true });
    this._opts = resolved;
  }

  get model(): string {
    return this._opts.model;
  }

  get provider(): string {
    return 'Gnani';
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    if (this._opts.synthesizeMethod === 'sse') {
      return new SSEChunkedStream(this, text, this._opts, connOptions, abortSignal);
    }
    if (this._opts.synthesizeMethod === 'websocket') {
      return new WebSocketChunkedStream(this, text, this._opts, connOptions, abortSignal);
    }
    return new RESTChunkedStream(this, text, this._opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SynthesizeStream(this, this._opts, options?.connOptions);
  }

  updateOptions(opts: Partial<TTSOptions> & Record<string, unknown>) {
    warnDeprecatedOptions(opts, 'TTS.updateOptions');
    this._opts = resolveOptions({ ...this._opts, ...opts });
  }
}

/** @public */
export type ChunkedStream = RESTChunkedStream | SSEChunkedStream | WebSocketChunkedStream;

/** @public */
export class RESTChunkedStream extends tts.ChunkedStream {
  private opts: ResolvedTTSOptions;
  private readonly timeoutMs: number;
  label = 'gnani.RESTChunkedStream';

  constructor(
    ttsInstance: TTS,
    text: string,
    opts: ResolvedTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.opts = { ...opts };
    this.timeoutMs = connOptions?.timeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.timeoutMs;
  }

  protected async run() {
    const signal = AbortSignal.any([this.abortSignal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await fetch(`${this.opts.baseURL}/api/v1/tts/inference`, {
      method: 'POST',
      headers: buildHeaders(this.opts),
      body: JSON.stringify(buildPayload(this.opts, this.inputText)),
      signal,
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new APITimeoutError({ message: 'Gnani TTS REST request timed out' });
      }
      throw new APIConnectionError({ message: `Gnani TTS REST error: ${String(error)}` });
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw apiError(`Gnani TTS API Error (${response.status}): ${errorText}`, response.status);
    }

    const audioBytes = Buffer.from(await response.arrayBuffer());
    const requestId = shortuuid();
    putFrames(
      this.queue,
      framesFromAudio(decodeAudioChunk(audioBytes, this.opts), this.opts),
      requestId,
      requestId,
    );
  }
}

/** @public */
export class SSEChunkedStream extends tts.ChunkedStream {
  private opts: ResolvedTTSOptions;
  private readonly timeoutMs: number;
  label = 'gnani.SSEChunkedStream';

  constructor(
    ttsInstance: TTS,
    text: string,
    opts: ResolvedTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.opts = { ...opts };
    this.timeoutMs = connOptions?.timeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.timeoutMs;
  }

  protected async run() {
    const response = await fetch(`${this.opts.baseURL}/api/v1/tts/sse`, {
      method: 'POST',
      headers: buildHeaders(this.opts),
      body: JSON.stringify(buildPayload(this.opts, this.inputText)),
      signal: AbortSignal.any([this.abortSignal, AbortSignal.timeout(this.timeoutMs)]),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new APITimeoutError({ message: 'Gnani TTS SSE request timed out' });
      }
      throw new APIConnectionError({ message: `Gnani TTS SSE error: ${String(error)}` });
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw apiError(`Gnani TTS SSE Error (${response.status}): ${errorText}`, response.status);
    }
    if (!response.body) {
      throw new APIConnectionError({ message: 'Gnani TTS SSE returned no response body' });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const requestId = shortuuid();
    const segmentId = requestId;
    const emitter = new IncrementalAudioEmitter(this.queue, this.opts, requestId, segmentId);

    const handlePayload = (payload: Record<string, unknown>) => {
      if (payload.status === 'error' || 'error' in payload) {
        throw apiError(String(payload.message ?? payload.error ?? 'Gnani TTS SSE error'));
      }
      if (payload.status === 'streaming_started') return false;
      const audio = typeof payload.audio === 'string' ? payload.audio : '';
      if (audio) {
        const chunk = decodeAudioChunk(Buffer.from(audio, 'base64'), this.opts);
        emitter.push(chunk);
      }
      return payload.is_final === true;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const dataLines = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        if (dataLines.length > 0) {
          const isFinal = handlePayload(JSON.parse(dataLines.join('')) as Record<string, unknown>);
          if (isFinal) {
            emitter.flush();
            return;
          }
        }
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }

    emitter.flush();
  }
}

/** @public */
export class WebSocketChunkedStream extends tts.ChunkedStream {
  private opts: ResolvedTTSOptions;
  private readonly timeoutMs: number;
  label = 'gnani.WebSocketChunkedStream';

  constructor(
    ttsInstance: TTS,
    text: string,
    opts: ResolvedTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.opts = { ...opts };
    this.timeoutMs = connOptions?.timeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.timeoutMs;
  }

  buildWsUrl(): string {
    return websocketURL(this.opts.baseURL, '/api/v1/tts');
  }

  protected async run() {
    const requestId = shortuuid();
    const segmentId = requestId;
    const emitter = new IncrementalAudioEmitter(this.queue, this.opts, requestId, segmentId);
    await synthesizeViaWebSocket(
      this.buildWsUrl(),
      this.inputText,
      this.opts,
      this.timeoutMs,
      (chunk) => emitter.push(chunk),
    );
    emitter.flush();
  }
}

/** @public */
export class SynthesizeStream extends tts.SynthesizeStream {
  private opts: ResolvedTTSOptions;
  label = 'gnani.SynthesizeStream';

  constructor(ttsInstance: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.opts = { ...opts };
  }

  buildWsUrl(): string {
    return websocketURL(this.opts.baseURL, '/api/v1/tts');
  }

  protected async run() {
    const textParts: string[] = [];
    for await (const data of this.input) {
      if (data === SynthesizeStream.FLUSH_SENTINEL) break;
      textParts.push(data);
    }

    const text = textParts.join('').trim();
    if (!text) return;

    const requestId = shortuuid();
    const segmentId = shortuuid();
    const emitter = new IncrementalAudioEmitter(this.queue, this.opts, requestId, segmentId);
    await synthesizeViaWebSocket(
      this.buildWsUrl(),
      text,
      this.opts,
      this.connOptions.timeoutMs,
      (chunk) => emitter.push(chunk),
      () => this.markStarted(),
    );
    emitter.flush();
    this.queue.put(SynthesizeStream.END_OF_STREAM);
  }
}

async function synthesizeViaWebSocket(
  url: string,
  text: string,
  opts: ResolvedTTSOptions,
  timeoutMs: number,
  onAudio: (chunk: Buffer) => void,
  onStarted?: () => void,
): Promise<void> {
  const ws = new WebSocket(url, {
    headers: buildHeaders(opts),
    handshakeTimeout: timeoutMs,
  });

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(mapWebSocketError(error));
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new APIConnectionError({ message: `Gnani TTS WebSocket closed: ${code}` }));
    };
    const cleanup = () => {
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
      ws.removeListener('close', onClose);
    };
    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);
  });

  ws.send(JSON.stringify(buildPayload(opts, text)));
  onStarted?.();

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const receiveTimeout = setTimeout(() => {
        settle(new APITimeoutError({ message: 'Gnani TTS WebSocket receive timed out' }));
      }, timeoutMs);
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(receiveTimeout);
        if (error) reject(error);
        else resolve();
      };

      ws.on('message', (msg: RawData, isBinary: boolean) => {
        try {
          if (isBinary) {
            const chunk = decodeAudioChunk(rawDataToBuffer(msg), opts);
            onAudio(chunk);
            return;
          }

          const payload = JSON.parse(msg.toString()) as Record<string, unknown>;
          const msgType = payload.type;
          const data = (payload.data ?? {}) as Record<string, unknown>;
          const audio = typeof data.audio === 'string' ? data.audio : '';

          if (msgType === 'audio') {
            if (audio) onAudio(decodeAudioChunk(Buffer.from(audio, 'base64'), opts));
          } else if (msgType === 'complete') {
            if (audio) onAudio(decodeAudioChunk(Buffer.from(audio, 'base64'), opts));
            settle();
          } else if (msgType === 'error') {
            settle(apiError(String(payload.message ?? data.message ?? 'Gnani TTS stream error')));
          }
        } catch (error) {
          if (
            error instanceof APIStatusError ||
            error instanceof APIConnectionError ||
            error instanceof APITimeoutError
          ) {
            settle(error);
          } else {
            settle(new APIConnectionError({ message: `Gnani TTS WebSocket error: ${error}` }));
          }
        }
      });
      ws.on('close', (code, reason) =>
        settle(
          new APIConnectionError({
            message: `Gnani TTS WebSocket closed before completion: ${code} ${reason?.toString() ?? ''}`,
          }),
        ),
      );
      ws.on('error', (error) => settle(mapWebSocketError(error)));
    });
  } finally {
    ws.close();
  }
}
