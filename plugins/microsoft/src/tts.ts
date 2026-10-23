// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APITimeoutError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { Configuration, type Fetch, HTTPClient, positiveTimeout, statusError } from './http.js';

const WAV_FORMATS = new Map<number, string>([
  [8000, 'riff-8khz-16bit-mono-pcm'],
  [22050, 'riff-22050hz-16bit-mono-pcm'],
  [24000, 'riff-24khz-16bit-mono-pcm'],
  [44100, 'riff-44100hz-16bit-mono-pcm'],
  [48000, 'riff-48khz-16bit-mono-pcm'],
]);

interface ResolvedTTSOptions {
  model: string;
  voice: string;
  sampleRate: number;
  language: string;
}

export interface TTSOptions {
  url: string;
  region: string;
  model: string;
  voice: string;
  language: string;
  sampleRate: number;
  apiKey: string;
  headers: Record<string, string>;
  fetch: Fetch;
  envFile: string;
  requestTimeout: number;
  maxTextLength: number;
  maxAudioBytes: number;
}

function endpoint(config: Configuration, url?: string, region?: string): string {
  const configuredUrl = url ?? config.get('MICROSOFT_AI_TTS_URL');
  if (configuredUrl !== undefined) return config.required(configuredUrl, 'MICROSOFT_AI_TTS_URL');
  let selectedRegion = region ?? config.get('MICROSOFT_AI_TTS_REGION');
  if (!selectedRegion) {
    throw new Error('Set MICROSOFT_AI_TTS_URL or MICROSOFT_AI_TTS_REGION, or pass url/region');
  }
  selectedRegion = selectedRegion.toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(selectedRegion)) {
    throw new Error('region must be a public-cloud Azure region identifier');
  }
  return `https://${selectedRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

function escapeXml(value: string, attribute = false): string {
  let escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (attribute) escaped = escaped.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return escaped;
}

function ssml(text: string, options: ResolvedTTSOptions): Uint8Array {
  return new TextEncoder().encode(
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(options.language, true)}"><voice name="${escapeXml(options.voice, true)}">${escapeXml(text)}</voice></speak>`,
  );
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function decodeWav(data: Uint8Array, sampleRate: number): Uint8Array {
  const invalid = () =>
    new APIError('Microsoft AI TTS returned invalid WAV audio', { retryable: false });
  if (data.length < 12 || ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WAVE') {
    throw invalid();
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd > data.length || riffEnd < 12) throw invalid();

  let formatValid = false;
  let formatSeen = false;
  let pcm: Uint8Array | undefined;
  let offset = 12;
  for (; offset + 8 <= riffEnd; ) {
    const id = ascii(data, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > riffEnd) throw invalid();
    if (id === 'fmt ') {
      if (size < 16) throw invalid();
      formatSeen = true;
      formatValid =
        view.getUint16(start, true) === 1 &&
        view.getUint16(start + 2, true) === 1 &&
        view.getUint32(start + 4, true) === sampleRate &&
        view.getUint32(start + 8, true) === sampleRate * 2 &&
        view.getUint16(start + 12, true) === 2 &&
        view.getUint16(start + 14, true) === 16;
    } else if (id === 'data' && pcm === undefined) {
      if (!formatSeen) throw invalid();
      pcm = data.slice(start, end);
    }
    offset = end + (size & 1);
    if (offset > riffEnd) throw invalid();
  }
  if (offset !== riffEnd) throw invalid();
  if (!formatValid) {
    throw new APIError('Microsoft AI TTS requires PCM16 mono WAV at the configured sample rate', {
      retryable: false,
    });
  }
  if (!pcm?.length || pcm.length % 2 !== 0) {
    throw new APIError('Microsoft AI TTS returned empty or truncated audio', { retryable: false });
  }
  return pcm;
}

export class TTS extends tts.TTS {
  label = 'microsoft.TTS';
  readonly #opts: ResolvedTTSOptions;
  readonly #client: HTTPClient;
  readonly #requestTimeout: number;
  readonly #maxTextLength: number;
  readonly #maxAudioBytes: number;
  readonly #streams = new Set<WeakRef<ChunkedStream>>();
  #closed = false;

  constructor(options: Partial<TTSOptions> = {}) {
    const config = new Configuration(options.envFile);
    let sampleRate = options.sampleRate;
    if (sampleRate === undefined) {
      const configured = config.get('MICROSOFT_AI_TTS_SAMPLE_RATE');
      if (configured === undefined || configured.trim() === '' || !/^[+-]?\d+$/.test(configured)) {
        throw new Error('Set MICROSOFT_AI_TTS_SAMPLE_RATE or pass sampleRate');
      }
      sampleRate = Number(configured);
    }
    if (!Number.isInteger(sampleRate) || !WAV_FORMATS.has(sampleRate)) {
      throw new Error('sampleRate must be one of 8000, 22050, 24000, 44100, 48000');
    }
    const requestTimeout = options.requestTimeout ?? 30_000;
    const maxTextLength = options.maxTextLength ?? 4096;
    const maxAudioBytes = options.maxAudioBytes ?? 10 * 1024 * 1024;
    for (const [name, value] of [
      ['maxTextLength', maxTextLength],
      ['maxAudioBytes', maxAudioBytes],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    positiveTimeout(requestTimeout, 'requestTimeout');
    super(sampleRate, 1, { streaming: false });

    const model = config.required(options.model, 'MICROSOFT_AI_TTS_MODEL');
    const voice = config.required(options.voice, 'MICROSOFT_AI_TTS_VOICE');
    const separator = voice.lastIndexOf(':');
    if (
      separator <= 0 ||
      voice.slice(separator + 1).toLocaleLowerCase() !== model.toLocaleLowerCase()
    ) {
      throw new Error('voice must be a full voice ID ending in the configured model name');
    }
    const language = options.language ?? 'en-US';
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
      throw new Error('language must be a language tag such as en-US');
    }
    this.#opts = { model, voice, sampleRate, language };
    this.#client = new HTTPClient({
      config,
      service: 'TTS',
      url: endpoint(config, options.url, options.region),
      apiKey: options.apiKey,
      headers: options.headers,
      fetch: options.fetch,
    });
    for (const name of Object.keys(this.#client.headers)) {
      if (['accept', 'content-type', 'x-microsoft-outputformat'].includes(name.toLowerCase())) {
        delete this.#client.headers[name];
      }
    }
    Object.assign(this.#client.headers, {
      Accept: 'audio/wav',
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': WAV_FORMATS.get(sampleRate)!,
    });
    this.#requestTimeout = requestTimeout;
    this.#maxTextLength = maxTextLength;
    this.#maxAudioBytes = maxAudioBytes;
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Microsoft AI';
  }

  synthesize(
    text: string,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    if (this.#closed) throw new Error('Microsoft AI TTS is closed');
    if (text.trim() === '') throw new Error('Microsoft AI TTS requires nonempty text');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/u.test(text)) {
      throw new Error('Microsoft AI TTS text contains characters invalid in XML');
    }
    if (text.length > this.#maxTextLength) {
      throw new Error('Microsoft AI TTS text exceeds maxTextLength');
    }
    positiveTimeout(connOptions.timeoutMs, 'connOptions.timeoutMs');
    const stream = new ChunkedStream(this, text, connOptions, abortSignal);
    this.#streams.add(new WeakRef(stream));
    return stream;
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Microsoft AI TTS');
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const reference of this.#streams) reference.deref()?.close();
    this.#streams.clear();
    this.#client.close();
  }

  /** @internal */
  async request(text: string, signal: AbortSignal, connectTimeout: number): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(this.#requestTimeout);
    const connectionController = new AbortController();
    const connectionTimer = setTimeout(() => connectionController.abort(), connectTimeout);
    const combined = AbortSignal.any([signal, timeout, connectionController.signal]);
    let response: Response;
    try {
      response = await this.#client.fetch(this.#client.url, {
        method: 'POST',
        headers: this.#client.headers,
        body: Buffer.from(ssml(text, this.#opts)),
        redirect: 'manual',
        signal: combined,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (timeout.aborted || connectionController.signal.aborted) {
        throw new APITimeoutError({ message: 'Microsoft AI TTS request timed out' });
      }
      throw new APIConnectionError({ message: 'Microsoft AI TTS transport failed' });
    } finally {
      clearTimeout(connectionTimer);
    }
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw signal.reason;
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw statusError('TTS', response.status);
    }
    const contentType = response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (!['audio/wav', 'audio/x-wav', 'audio/wave'].includes(contentType ?? '')) {
      void response.body?.cancel().catch(() => {});
      throw new APIError('Microsoft AI TTS expected a WAV response', { retryable: false });
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > this.#maxAudioBytes) {
      void response.body?.cancel().catch(() => {});
      throw new APIError('Microsoft AI TTS response exceeds maxAudioBytes', { retryable: false });
    }
    const reader = response.body?.getReader();
    if (!reader) return decodeWav(new Uint8Array(), this.sampleRate);
    const cancelReader = () => {
      void reader.cancel().catch(() => {});
    };
    combined.addEventListener('abort', cancelReader, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > this.#maxAudioBytes) {
          void reader.cancel().catch(() => {});
          throw new APIError('Microsoft AI TTS response exceeds maxAudioBytes', {
            retryable: false,
          });
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof APIError) throw error;
      if (signal.aborted) throw error;
      if (timeout.aborted) {
        throw new APITimeoutError({ message: 'Microsoft AI TTS request timed out' });
      }
      throw new APIConnectionError({ message: 'Microsoft AI TTS transport failed' });
    } finally {
      combined.removeEventListener('abort', cancelReader);
    }
    if (signal.aborted) throw signal.reason;
    if (timeout.aborted) {
      throw new APITimeoutError({ message: 'Microsoft AI TTS request timed out' });
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return decodeWav(data, this.sampleRate);
  }

  /** @internal */
  forget(stream: ChunkedStream): void {
    for (const reference of this.#streams) {
      const current = reference.deref();
      if (current === undefined || current === stream) this.#streams.delete(reference);
    }
  }
}

class ChunkedStream extends tts.ChunkedStream {
  label = 'microsoft.ChunkedStream';
  readonly #tts: TTS;
  readonly #connectTimeout: number;
  readonly #maxRetry: number;
  #attempt = 0;

  constructor(
    ttsInstance: TTS,
    text: string,
    connOptions: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#tts = ttsInstance;
    this.#connectTimeout = connOptions.timeoutMs;
    this.#maxRetry = connOptions.maxRetry;
  }

  protected async run(): Promise<void> {
    this.#attempt++;
    let terminal = true;
    try {
      const pcm = await this.#tts.request(this.inputText, this.abortSignal, this.#connectTimeout);
      if (this.abortSignal.aborted) return;
      const requestId = shortuuid();
      const byteStream = new AudioByteStream(this.#tts.sampleRate, this.#tts.numChannels);
      const frames = [...byteStream.write(pcm), ...byteStream.flush()];
      let previous: AudioFrame | undefined;
      for (const frame of frames) {
        if (previous) {
          this.queue.put({ requestId, segmentId: requestId, frame: previous, final: false });
        }
        previous = frame;
      }
      if (previous) {
        this.queue.put({ requestId, segmentId: requestId, frame: previous, final: true });
      }
    } catch (error) {
      if (this.abortSignal.aborted) return;
      terminal = !(error instanceof APIError) || !error.retryable || this.#attempt > this.#maxRetry;
      throw error;
    } finally {
      if (terminal) this.#tts.forget(this);
    }
  }

  close(): void {
    super.close();
    this.#tts.forget(this);
  }

  async next(): Promise<IteratorResult<tts.SynthesizedAudio>> {
    if (this.closed) return { done: true, value: undefined };
    const result = await super.next();
    return this.closed ? { done: true, value: undefined } : result;
  }
}
