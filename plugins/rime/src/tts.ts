// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { RimePool, bounded, connectionPools } from './connection.js';
import {
  type TTSOptions,
  fetchPayload,
  getSampleRate,
  resolveOptions,
  warnIfArcana,
  wsUrl,
} from './options.js';
import { SynthesizeStream } from './stream.js';

export type { TTSOptions, RimeAudioFormat, WebSocketProtocol } from './options.js';
export { SynthesizeStream } from './stream.js';

export class TTS extends tts.TTS {
  private opts: TTSOptions;
  private pool?: RimePool;
  private pools = new Set<RimePool>();
  private streams = new Set<SynthesizeStream>();
  private isClosed = false;
  label = 'rime.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolved = resolveOptions(opts);
    super(getSampleRate(resolved), 1, {
      streaming: resolved.useWebsocket ?? false,
      alignedTranscript: Boolean(resolved.useWebsocket && !resolved.websocketURL),
    });
    this.opts = resolved;
    warnIfArcana(opts.modelId);
    this.replacePool();
  }

  override get sampleRate() {
    return getSampleRate(this.opts);
  }
  get model() {
    return this.opts.modelId;
  }
  get provider() {
    return 'Rime';
  }

  private replacePool() {
    if (!this.opts.useWebsocket) return;
    const previous = this.pool;
    const pool = new RimePool(
      this.opts.websocketURL ?? wsUrl(this.opts),
      this.opts.apiKey!,
      this.opts.websocketURL ? this.opts.websocketProtocol : undefined,
      () => this.pools.delete(pool),
    );
    this.pool = pool;
    this.pools.add(this.pool);
    connectionPools.set(this, this.pool);
    previous?.retire();
  }

  updateOptions(opts: Partial<TTSOptions>) {
    if (this.isClosed) throw new Error('Rime TTS is closed');
    const next = resolveOptions(opts, this.opts);
    const identity = (value: TTSOptions) =>
      JSON.stringify([value.websocketURL ?? wsUrl(value), value.apiKey, value.websocketProtocol]);
    const changed = identity(next) !== identity(this.opts);
    this.opts = next;
    warnIfArcana(opts.modelId);
    if (changed) this.replacePool();
  }

  prewarm() {
    if (!this.isClosed) this.pool?.pool.prewarm();
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    if (this.isClosed) throw new Error('Rime TTS is closed');
    if (this.opts.useWebsocket) throw new Error('Rime one-shot synthesis requires HTTP mode');
    return new ChunkedStream(this, text, { ...this.opts }, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    if (this.isClosed) throw new Error('Rime TTS is closed');
    if (!this.pool) throw new Error('Rime streaming requires useWebsocket or websocketURL');
    const result = new SynthesizeStream(this, { ...this.opts }, options?.connOptions);
    this.streams.add(result);
    void result.waitClosed().then(() => this.streams.delete(result));
    return result;
  }

  override async close() {
    this.isClosed = true;
    connectionPools.delete(this);
    const streams = [...this.streams];
    streams.forEach((value) => value.close());
    await Promise.all(streams.map((value) => value.waitClosed()));
    await Promise.all([...this.pools].map((value) => value.close()));
    this.pools.clear();
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'rime-tts.ChunkedStream';
  private opts: TTSOptions;
  private requestOptions: APIConnectOptions;
  constructor(
    parent: TTS,
    private text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, parent, connOptions, abortSignal);
    this.opts = { ...opts };
    this.requestOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
    if (abortSignal?.aborted) this.close();
  }

  protected async run() {
    if (this.abortSignal.aborted) return;
    const requestId = shortuuid();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.abortSignal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let emitted = false;
    try {
      const response = await bounded(
        fetch(this.opts.baseURL!, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Accept: 'audio/pcm',
            Authorization: `Bearer ${this.opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fetchPayload(this.opts, this.text)),
          signal,
        }),
        signal,
        this.requestOptions.timeoutMs,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new APIStatusError({
          message: 'Rime HTTP request failed',
          options: { statusCode: response.status },
        });
      }
      if (!response.body)
        throw new APIConnectionError({ message: 'Rime HTTP response has no body' });
      const bytes = new AudioByteStream(getSampleRate(this.opts), 1);
      let last: AudioFrame | undefined;
      let byteCount = 0;
      const emit = (final: boolean) => {
        if (last && !this.queue.closed) {
          emitted = true;
          this.queue.put({ requestId, segmentId: requestId, frame: last, final });
        }
      };
      reader = response.body.getReader();
      while (true) {
        const result = await bounded(reader.read(), signal, this.requestOptions.timeoutMs);
        if (result.done) break;
        byteCount += result.value.length;
        for (const frame of bytes.write(result.value)) {
          emit(false);
          last = frame;
        }
      }
      if (byteCount % 2)
        throw new APIError('Rime returned incomplete PCM audio', { retryable: false });
      for (const frame of bytes.flush()) {
        emit(false);
        last = frame;
      }
      emit(true);
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) {
        if (emitted && error.retryable) throw new APIError(error.message, { retryable: false });
        throw error;
      }
      throw new APIConnectionError({
        message: 'Rime HTTP request failed',
        options: { retryable: !emitted },
      });
    } finally {
      controller.abort();
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
}
