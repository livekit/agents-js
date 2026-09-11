// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { create } from '@bufbuild/protobuf';
import {
  type APIConnectOptions,
  APIError,
  APIStatusError,
  APITimeoutError,
  AsyncIterableQueue,
  Future,
  type TimedString,
  createTimedString,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { SynthesisRequestSchema, WebSocketCancelSchema, WebSocketEndSchema } from '@rimelabs/api';
import { RimeAudio } from './audio.js';
import type { RimeConnection } from './connection.js';
import {
  type RimePool,
  bounded,
  connectionError,
  connectionPools,
  providerError,
} from './connection.js';
import { type TTSOptions, getSampleRate } from './options.js';
import type { TTS } from './tts.js';

export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'rime-tts.SynthesizeStream';
  private sentences = new AsyncIterableQueue<string>();
  private history: string[] = [];
  private inputTask?: Promise<void>;
  private inputError?: APIError;
  private inputAbort = new AbortController();
  private tokenizer?: tokenize.SentenceStream;
  private finished = new Future<void>();
  private pool: RimePool;

  constructor(
    parent: TTS,
    private opts: TTSOptions,
    connOptions?: APIConnectOptions,
  ) {
    super(parent, connOptions);
    this.opts = { ...opts };
    const pool = connectionPools.get(parent);
    if (!pool) throw new Error('Rime connection pool is not initialized');
    this.pool = pool;
    this.pool.retain();
    // Record text before the metrics task observes cancellation, even with queued audio.
    this.abortSignal.addEventListener('abort', () => super.flush(), { once: true });
  }

  protected override get metricsModel(): string {
    return this.opts.modelId;
  }

  override flush() {
    if (!this.opts.websocketURL) {
      super.flush();
      return;
    }
    if (!this.input.closed && !this.closed) this.input.put(SynthesizeStream.FLUSH_SENTINEL);
  }

  override endInput() {
    if (this.input.closed || this.closed) return;
    // Record one metric text for the whole context. Local flush does not end it.
    super.flush();
    this.input.close();
  }

  /** Wait for cancellation and socket cleanup after close(). */
  async waitClosed() {
    await this.finished.await;
  }

  protected override onStreamDone() {
    // Local v1 flushes keep one context open. Commit any remaining metric text on failure too.
    super.flush();
    this.inputAbort.abort();
    this.tokenizer?.close();
    this.pool.release();
    this.finished.resolve();
  }

  private startInput() {
    if (this.inputTask) return;
    const tokenizer = (
      this.opts.tokenizer ??
      new tokenize.basic.SentenceTokenizer(
        this.opts.websocketURL ? { minSentenceLength: 1, streamContextLength: 1 } : undefined,
      )
    ).stream(this.opts.lang);
    this.tokenizer = tokenizer;
    const failInput = () => {
      this.inputError = new APIError('Rime sentence tokenization failed', { retryable: false });
      this.inputAbort.abort();
    };
    this.inputTask = (async () => {
      const forward = (async () => {
        for await (const event of tokenizer) {
          if (event.token && !this.sentences.closed)
            this.sentences.put(/\s$/.test(event.token) ? event.token : `${event.token} `);
        }
      })().catch(failInput);
      try {
        while (!this.abortSignal.aborted) {
          const event = await this.input.next({
            signal: AbortSignal.any([this.abortSignal, this.inputAbort.signal]),
          });
          if (event.done) break;
          if (event.value === SynthesizeStream.FLUSH_SENTINEL) tokenizer.flush();
          else tokenizer.pushText(event.value);
        }
        tokenizer.endInput();
      } finally {
        tokenizer.close();
        await forward;
      }
    })()
      .catch(failInput)
      .finally(() => this.sentences.close());
  }

  private async *text(signal: AbortSignal) {
    // Replay sentences on pre-audio retries. The input pump belongs to the logical stream.
    for (const sentence of this.history) yield sentence;
    while (true) {
      const event = await this.sentences.next({ signal });
      if (event.done) {
        if (this.inputError) throw this.inputError;
        return;
      }
      this.history.push(event.value);
      yield event.value;
    }
  }

  protected async run() {
    if (this.abortSignal.aborted) return;
    this.startInput();
    let connection: RimeConnection | undefined;
    let reusable = false;
    let active = false;
    let started = false;
    let inputEnding = false;
    let terminal = false;
    let emitted = false;
    let requestId = shortuuid();
    const contextId = shortuuid();
    const v1 = !!this.opts.websocketURL;
    const attempt = new AbortController();
    const signal = AbortSignal.any([this.abortSignal, attempt.signal]);
    const activated = new Future<void>();
    let failure: APIError | undefined;
    let startedTimer: NodeJS.Timeout | undefined;
    let terminalTimer: NodeJS.Timeout | undefined;
    let lastFrame: AudioFrame | undefined;
    let transcripts: TimedString[] = [];
    const emit = (final: boolean) => {
      if (lastFrame && !this.queue.closed && !this.abortSignal.aborted) {
        emitted = true;
        this.queue.put({
          requestId,
          segmentId: contextId,
          frame: lastFrame,
          final,
          timedTranscripts: transcripts.length ? transcripts : undefined,
        });
        lastFrame = undefined;
        transcripts = [];
      }
    };
    const audio = new RimeAudio(
      this.opts.audioFormat ?? 'audio/pcm',
      getSampleRate(this.opts),
      (frame) => {
        emit(false);
        lastFrame = frame;
      },
    );
    const timeout = () => {
      failure = new APITimeoutError({ message: 'Timed out waiting for a Rime synthesis event' });
      attempt.abort();
    };
    const watchTerminal = () => {
      if (terminalTimer) clearTimeout(terminalTimer);
      terminalTimer = setTimeout(timeout, this.connOptions.timeoutMs);
    };
    const tasks: Promise<void>[] = [];
    try {
      // Lock waits and replacement of stale connections share one acquisition deadline.
      const deadline = performance.now() + this.connOptions.timeoutMs;
      while (!connection) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new APITimeoutError({ message: 'Rime acquisition timed out' });
        const acquisition = this.pool.pool.get(remaining);
        try {
          const acquired = await bounded(acquisition, this.abortSignal, remaining);
          if (acquired.reusable) connection = acquired;
          else this.pool.pool.remove(acquired);
        } catch (error) {
          // A late connection belongs to the expired or cancelled acquisition.
          void acquisition.then(
            (conn) => this.pool.pool.remove(conn),
            () => {},
          );
          throw error;
        }
      }
      const conn = connection;
      const send = async () => {
        for await (const text of this.text(signal)) {
          if (signal.aborted) return;
          if (!active) {
            active = true;
            activated.resolve();
            startedTimer = setTimeout(timeout, this.connOptions.timeoutMs);
            this.markStarted();
            if (v1) {
              const start = create(SynthesisRequestSchema, {
                text: '',
                speaker: this.opts.speaker,
                language: this.opts.lang,
                audioParameters: {
                  audioFormat: this.opts.audioFormat,
                  samplingRate: getSampleRate(this.opts),
                  timeScaleFactor:
                    this.opts.modelId === 'mistv2' ? undefined : this.opts.timeScaleFactor,
                },
                mistParameters:
                  this.opts.modelId.includes('mist') &&
                  (this.opts.pauseBetweenBrackets !== undefined ||
                    this.opts.phonemizeBetweenBrackets !== undefined)
                    ? {
                        pauseBetweenBrackets: this.opts.pauseBetweenBrackets,
                        phonemizeBetweenBrackets: this.opts.phonemizeBetweenBrackets,
                      }
                    : undefined,
              });
              await conn.sendV1(
                contextId,
                { case: 'start', value: start },
                signal,
                this.connOptions.timeoutMs,
              );
            }
          }
          if (v1)
            await conn.sendV1(
              contextId,
              { case: 'text', value: text },
              signal,
              this.connOptions.timeoutMs,
            );
          else
            await conn.send(
              JSON.stringify({ contextId, text }),
              signal,
              this.connOptions.timeoutMs,
            );
        }
        if (active) {
          inputEnding = true;
          if (v1)
            await conn.sendV1(
              contextId,
              { case: 'end', value: create(WebSocketEndSchema) },
              signal,
              this.connOptions.timeoutMs,
            );
          else
            await conn.send(
              JSON.stringify({ contextId, operation: 'flush' }),
              signal,
              this.connOptions.timeoutMs,
            );
          if (!terminal) watchTerminal();
        } else activated.resolve();
      };
      const receive = async () => {
        await bounded(activated.await, signal);
        if (!active) return;
        while (!signal.aborted) {
          if (v1) {
            const response = await conn.receiveV1(signal);
            const payload = response.payload;
            if (payload.case === 'error' && !response.contextId)
              throw providerError(payload.value, requestId);
            if (response.contextId !== contextId)
              throw new APIError('Rime v1 event has an unexpected contextId', { retryable: false });
            switch (payload.case) {
              case 'started':
                if (started || !payload.value.requestId) throw connectionError();
                started = true;
                clearTimeout(startedTimer);
                requestId = payload.value.requestId;
                this.noteProviderRequestId(requestId);
                break;
              case 'audio':
                if (!started) throw connectionError();
                await bounded(audio.push(payload.value), signal, this.connOptions.timeoutMs);
                break;
              case 'done':
                if (!started || !inputEnding)
                  throw new APIError('Rime v1 completed before input ended or before started', {
                    retryable: false,
                  });
                terminal = true;
                break;
              case 'error':
                throw providerError(payload.value, requestId);
              default:
                throw new APIError('Rime v1 sent an unexpected event', { retryable: false });
            }
          } else {
            const frame = await conn.receive(signal);
            if (frame.binary) throw connectionError();
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(frame.data.toString());
              if (!data || typeof data !== 'object') throw connectionError();
            } catch {
              throw new APIError('Rime WebSocket sent invalid JSON', { retryable: false });
            }
            if (data.contextId !== undefined && data.contextId !== contextId)
              throw connectionError();
            clearTimeout(startedTimer);
            if (data.type === 'chunk') {
              if (typeof data.data !== 'string') throw connectionError();
              await audio.push(Buffer.from(data.data, 'base64'));
            } else if (data.type === 'timestamps') {
              const timing = data.word_timestamps as
                | { words?: string[]; start?: number[]; end?: number[] }
                | undefined;
              if (
                Array.isArray(timing?.words) &&
                Array.isArray(timing.start) &&
                Array.isArray(timing.end)
              ) {
                timing.words.forEach((word, i) => {
                  if (
                    typeof word === 'string' &&
                    typeof timing.start![i] === 'number' &&
                    typeof timing.end![i] === 'number'
                  )
                    transcripts.push(
                      createTimedString({
                        text: `${word} `,
                        startTime: timing.start![i]!,
                        endTime: timing.end![i]!,
                      }),
                    );
                });
              }
            } else if (data.type === 'done') {
              if (!inputEnding) throw connectionError();
              terminal = true;
            } else if (data.type === 'error') throw new APIError('Rime WebSocket request failed');
            else throw connectionError();
          }
          if (terminal) {
            clearTimeout(terminalTimer);
            await bounded(audio.end(), signal, this.connOptions.timeoutMs);
            if (v1 && !emitted && !lastFrame)
              throw new APIError('Rime synthesis completed without audio', { retryable: true });
            emit(true);
            return;
          }
          if (inputEnding) watchTerminal();
        }
      };
      tasks.push(send(), receive());
      await Promise.all(tasks);
      reusable = true;
    } catch (error) {
      attempt.abort();
      await Promise.allSettled(tasks);
      if (this.abortSignal.aborted) {
        reusable = !active || terminal;
        if (connection && active && !terminal && v1)
          reusable = await this.cancel(connection, contextId);
        return;
      }
      const safe = failure ?? (error instanceof APIError ? error : connectionError());
      if (emitted && safe.retryable) {
        if (safe instanceof APIStatusError)
          throw new APIStatusError({
            message: safe.message,
            options: {
              statusCode: safe.statusCode,
              requestId: safe.requestId,
              body: safe.body,
              retryable: false,
            },
          });
        throw new APIError(safe.message, { retryable: false });
      }
      throw safe;
    } finally {
      clearTimeout(startedTimer);
      clearTimeout(terminalTimer);
      attempt.abort();
      await Promise.allSettled(tasks);
      audio.close();
      if (connection) {
        if (reusable && connection.reusable) this.pool.pool.put(connection);
        else this.pool.pool.remove(connection);
      }
    }
  }

  private async cancel(connection: RimeConnection, contextId: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = Math.min(1000, this.connOptions.timeoutMs);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      await connection.sendV1(
        contextId,
        { case: 'cancel', value: create(WebSocketCancelSchema) },
        controller.signal,
        timeout,
      );
      while (true) {
        const response = await connection.receiveV1(controller.signal);
        if (response.contextId !== contextId) return false;
        if (response.payload.case === 'done' || response.payload.case === 'cancelled') return true;
        if (response.payload.case !== 'audio' && response.payload.case !== 'started') return false;
      }
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
