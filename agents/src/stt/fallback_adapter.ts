// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, intervalForRetry } from '../types.js';
import type { AudioBuffer } from '../utils.js';
import { Task, cancelAndWait, combineSignals, delay } from '../utils.js';
import type { VAD } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import type { STTError, SpeechEvent } from './stt.js';
import { STT, SpeechEventType, SpeechStream } from './stt.js';

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

interface STTStatus {
  available: boolean;
  recoveringRecognizeTask: Task<void> | null;
  recoveringStreamTask: Task<void> | null;
}

interface FallbackAdapterOptions {
  sttInstances: STT[];
  vad?: VAD;
  attemptTimeoutMs?: number;
  maxRetryPerSTT?: number;
  retryIntervalMs?: number;
}

export interface AvailabilityChangedEvent {
  stt: STT;
  available: boolean;
}

export class FallbackAdapter extends STT {
  label = 'stt.FallbackAdapter';

  readonly sttInstances: STT[];
  readonly attemptTimeoutMs: number;
  readonly maxRetryPerSTT: number;
  readonly retryIntervalMs: number;

  private _status: STTStatus[];
  private _logger = log();

  constructor(opts: FallbackAdapterOptions) {
    if (!opts.sttInstances || opts.sttInstances.length < 1) {
      throw new Error('At least one STT instance must be provided.');
    }
    let sttInstances = opts.sttInstances;
    const nonStreaming = sttInstances.filter((s: STT) => !s.capabilities.streaming);
    if (nonStreaming.length > 0) {
      if (!opts.vad) {
        const labels = nonStreaming.map((s: STT) => s.label).join(', ');
        throw new Error(
          `STTs do not support streaming: ${labels}. ` +
            'Provide a VAD to enable stt.StreamAdapter automatically ' +
            'or wrap them with stt.StreamAdapter before using this adapter.',
        );
      }
      const vad = opts.vad;
      sttInstances = sttInstances.map((s: STT) =>
        s.capabilities.streaming ? s : new StreamAdapter(s, vad),
      );
    }

    super({
      streaming: true,
      interimResults: sttInstances.every((s) => s.capabilities.interimResults),
    });

    if (opts.attemptTimeoutMs !== undefined && opts.attemptTimeoutMs <= 0) {
      throw new Error('attemptTimeoutMs must be a positive number.');
    }
    if (opts.maxRetryPerSTT !== undefined && opts.maxRetryPerSTT < 0) {
      throw new Error('maxRetryPerSTT must be a non-negative number.');
    }
    if (opts.retryIntervalMs !== undefined && opts.retryIntervalMs < 0) {
      throw new Error('retryIntervalMs must be a non-negative number.');
    }

    this.sttInstances = sttInstances;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 5000;
    this.maxRetryPerSTT = opts.maxRetryPerSTT ?? 1;
    this.retryIntervalMs = opts.retryIntervalMs ?? 1000;
    this._status = sttInstances.map(() => ({
      available: true,
      recoveringRecognizeTask: null,
      recoveringStreamTask: null,
    }));
    this.setupEventForwarding();
  }

  get status(): STTStatus[] {
    return this._status;
  }

  private setupEventForwarding(): void {
    this.sttInstances.forEach((stt: STT) => {
      stt.on('metrics_collected', (metrics) => this.emit('metrics_collected', metrics));
      stt.on('error', (error) => this.emit('error', error));
    });
  }

  emitAvailabilityChanged(stt: STT, available: boolean): void {
    const event: AvailabilityChangedEvent = { stt, available };
    (this as unknown as { emit: (event: string, data: AvailabilityChangedEvent) => void }).emit(
      'stt_availability_changed',
      event,
    );
  }

  private async tryRecognize({
    stt,
    buffer,
    connOptions,
    abortSignal,
    recovering = false,
  }: {
    stt: STT;
    buffer: AudioBuffer;
    connOptions: APIConnectOptions;
    abortSignal?: AbortSignal;
    recovering?: boolean;
  }): Promise<SpeechEvent> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), connOptions.timeoutMs);

    const effectiveSignal = abortSignal
      ? combineSignals(abortSignal, timeoutController.signal)
      : timeoutController.signal;

    try {
      return await stt.recognize(buffer, effectiveSignal);
    } catch (e) {
      if (recovering) {
        if (e instanceof APIError) {
          this._logger.warn({ stt: stt.label, error: e }, 'recovery failed');
        } else {
          this._logger.warn({ stt: stt.label, error: e }, 'recovery unexpected error');
        }
      } else {
        if (e instanceof APIError) {
          this._logger.warn({ stt: stt.label, error: e }, 'failed, switching to next STT');
        } else {
          this._logger.warn(
            { stt: stt.label, error: e },
            'unexpected error, switching to next STT',
          );
        }
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  private tryRecoverRecognize({
    stt,
    buffer,
    connOptions,
  }: {
    stt: STT;
    buffer: AudioBuffer;
    connOptions: APIConnectOptions;
  }): void {
    const index = this.sttInstances.indexOf(stt);
    const sttStatus = this._status[index]!;

    if (sttStatus.recoveringRecognizeTask && !sttStatus.recoveringRecognizeTask.done) {
      this._logger.debug({ stt: stt.label }, 'recognize recovery already in progress, skipping');
      return;
    }

    sttStatus.recoveringRecognizeTask = Task.from(async (controller) => {
      try {
        await this.tryRecognize({
          stt,
          buffer,
          connOptions,
          abortSignal: controller.signal,
          recovering: true,
        });
        sttStatus.available = true;
        this._logger.info({ stt: stt.label }, 'recovered');
        this.emitAvailabilityChanged(stt, true);
      } catch (e) {
        if (controller.signal.aborted) return;
        this._logger.debug({ stt: stt.label, error: e }, 'recognize recovery attempt failed');
      }
    });
  }

  protected async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<SpeechEvent> {
    const startTime = Date.now();

    const allFailed = this._status.every((s) => !s.available);
    if (allFailed) {
      this._logger.error('all STTs are unavailable, retrying...');
    }

    const connOptions: APIConnectOptions = {
      ...DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
      maxRetry: this.maxRetryPerSTT,
      timeoutMs: this.attemptTimeoutMs,
      retryIntervalMs: this.retryIntervalMs,
    };

    for (let i = 0; i < this.sttInstances.length; i++) {
      const stt = this.sttInstances[i]!;
      const sttStatus = this._status[i]!;

      if (sttStatus.available || allFailed) {
        let lastError: unknown;
        for (let attempt = 0; attempt <= connOptions.maxRetry; attempt++) {
          try {
            return await this.tryRecognize({
              stt,
              buffer,
              connOptions,
              abortSignal,
              recovering: false,
            });
          } catch (e) {
            lastError = e;
            if (attempt < connOptions.maxRetry && e instanceof APIError && e.retryable) {
              const retryInterval = intervalForRetry(connOptions, attempt);
              if (retryInterval > 0) {
                await delay(retryInterval, { signal: abortSignal });
              }
              continue;
            }
            break;
          }
        }
        if (lastError) {
          if (sttStatus.available) {
            sttStatus.available = false;
            this.emitAvailabilityChanged(stt, false);
          }
        }
      }

      this.tryRecoverRecognize({ stt, buffer, connOptions });
    }

    const labels = this.sttInstances.map((s) => s.label).join(', ');
    throw new APIConnectionError({
      message: `all STTs failed (${labels}) after ${Date.now() - startTime}ms`,
    });
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    return new FallbackSpeechStream(
      this,
      options?.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
    );
  }

  async close(): Promise<void> {
    const tasks = this._status.flatMap((s) =>
      [s.recoveringRecognizeTask, s.recoveringStreamTask].filter(
        (t): t is Task<void> => t !== null,
      ),
    );

    if (tasks.length > 0) {
      await cancelAndWait(tasks, 1000);
    }

    for (const stt of this.sttInstances) {
      stt.removeAllListeners('metrics_collected');
      stt.removeAllListeners('error');
    }

    await Promise.all(this.sttInstances.map((s) => s.close()));
  }
}

class FallbackSpeechStream extends SpeechStream {
  label = 'stt.FallbackSpeechStream';

  private adapter: FallbackAdapter;
  private connOptions: APIConnectOptions;
  private _logger = log();
  private recoveringStreams: SpeechStream[] = [];

  constructor(adapter: FallbackAdapter, connOptions: APIConnectOptions) {
    super(adapter, undefined, connOptions);
    this.adapter = adapter;
    this.connOptions = connOptions;
  }

  async monitorMetrics(): Promise<void> {
    return;
  }

  private cleanupRecoveringStreams(): void {
    const streams = this.recoveringStreams;
    this.recoveringStreams = [];
    for (const stream of streams) {
      try {
        stream.close();
      } catch (e) {
        this._logger.debug({ error: e }, 'error closing recovering stream');
      }
    }
  }

  protected async run(): Promise<void> {
    const startTime = Date.now();

    const allFailed = this.adapter.status.every((s) => !s.available);
    if (allFailed) {
      this._logger.error('all STTs are unavailable, retrying...');
    }

    let mainStream: SpeechStream | null = null;
    let forwardInputDone = false;

    const forwardInput = async () => {
      try {
        for await (const data of this.input) {
          const recoveringSnapshot = [...this.recoveringStreams];
          for (const stream of recoveringSnapshot) {
            try {
              if (data === SpeechStream.FLUSH_SENTINEL) {
                stream.flush();
              } else {
                stream.pushFrame(data as AudioFrame);
              }
            } catch (e) {
              if (!(e instanceof Error && e.message.includes('closed'))) {
                this._logger.warn({ error: e }, 'error forwarding input to recovering stream');
              }
            }
          }

          if (mainStream) {
            try {
              if (data === SpeechStream.FLUSH_SENTINEL) {
                mainStream.flush();
              } else {
                mainStream.pushFrame(data as AudioFrame);
              }
            } catch (e) {
              if (!(e instanceof Error && e.message.includes('closed'))) {
                this._logger.warn({ error: e }, 'error forwarding input to main stream');
              }
            }
          }
        }
      } finally {
        forwardInputDone = true;
        if (mainStream) {
          try {
            mainStream.endInput();
          } catch (e) {
            this._logger.debug({ error: e }, 'error ending main stream input');
          }
        }
        for (const stream of [...this.recoveringStreams]) {
          try {
            stream.endInput();
          } catch (e) {
            this._logger.debug({ error: e }, 'error ending recovering stream input');
          }
        }
      }
    };

    let forwardInputTask: Promise<void> | null = null;

    try {
      for (let i = 0; i < this.adapter.sttInstances.length; i++) {
        const stt = this.adapter.sttInstances[i]!;
        const sttStatus = this.adapter.status[i]!;

        if (sttStatus.available || allFailed) {
          try {
            const streamConnOptions: APIConnectOptions = {
              ...this.connOptions,
              maxRetry: this.adapter.maxRetryPerSTT,
              timeoutMs: this.adapter.attemptTimeoutMs,
              retryIntervalMs: this.adapter.retryIntervalMs,
            };

            mainStream = stt.stream({ connOptions: streamConnOptions });

            if (!forwardInputTask || forwardInputDone) {
              forwardInputTask = forwardInput();
            }

            // The child SpeechStream swallows its own run() errors: mainTask() catches
            // them, emits on the STT, re-throws into startSoon (unhandled), and then
            // closes this.queue via .finally(). monitorMetrics() drains the queue and
            // closes output, so the for-await below exits via { done: true } rather
            // than throwing. We capture the error event to detect silent failures.
            let streamError: unknown = null;
            const captureStreamError = (err: STTError) => {
              streamError = err.error;
            };
            stt.once('error', captureStreamError);
            try {
              for await (const ev of mainStream) {
                this.output.put(ev);
              }
            } finally {
              stt.off('error', captureStreamError);
            }

            if (streamError !== null) {
              if (streamError instanceof APIError) {
                this._logger.warn(
                  { stt: stt.label, error: streamError },
                  'failed, switching to next STT',
                );
              } else {
                this._logger.warn(
                  { stt: stt.label, error: streamError },
                  'unexpected error, switching to next STT',
                );
              }
              mainStream.close();
              mainStream = null;
              throw streamError;
            }

            this.cleanupRecoveringStreams();
            return;
          } catch (e) {
            if (!(e instanceof APIError) && !(e instanceof APIConnectionError)) {
              this._logger.warn({ stt: stt.label, error: e }, 'unexpected error in stream loop');
            }
            if (sttStatus.available) {
              sttStatus.available = false;
              this.adapter.emitAvailabilityChanged(stt, false);
            }
          }
        }

        this.tryStreamRecovery(stt);
      }

      this.cleanupRecoveringStreams();

      const labels = this.adapter.sttInstances.map((s) => s.label).join(', ');
      throw new APIConnectionError({
        message: `all STTs failed (${labels}) after ${Date.now() - startTime}ms`,
      });
    } finally {
      this.cleanupRecoveringStreams();
      if (forwardInputTask) {
        if (!this.input.closed) {
          this.input.close();
        }
        await forwardInputTask.catch(() => {});
      }
      if (!this.output.closed) {
        this.output.close();
      }
    }
  }

  private tryStreamRecovery(stt: STT): void {
    const index = this.adapter.sttInstances.indexOf(stt);
    const sttStatus = this.adapter.status[index]!;

    if (sttStatus.recoveringStreamTask && !sttStatus.recoveringStreamTask.done) {
      this._logger.debug({ stt: stt.label }, 'stream recovery already in progress, skipping');
      return;
    }

    const streamConnOptions: APIConnectOptions = {
      ...this.connOptions,
      maxRetry: 0,
      timeoutMs: this.adapter.attemptTimeoutMs,
      retryIntervalMs: this.adapter.retryIntervalMs,
    };

    const stream = stt.stream({ connOptions: streamConnOptions });
    this.recoveringStreams.push(stream);

    sttStatus.recoveringStreamTask = Task.from(async (controller) => {
      const onAbort = () => stream.close();
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        let transcriptCount = 0;
        for await (const ev of stream) {
          if (controller.signal.aborted) break;
          if (ev.type === SpeechEventType.FINAL_TRANSCRIPT) {
            if (!ev.alternatives || !ev.alternatives[0].text) {
              continue;
            }
            transcriptCount++;
            break;
          }
        }

        if (transcriptCount === 0 || controller.signal.aborted) {
          return;
        }

        sttStatus.available = true;
        this._logger.info({ stt: stt.label }, 'recovered');
        this.adapter.emitAvailabilityChanged(stt, true);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof APIError) {
          this._logger.warn({ stt: stt.label, error: e }, 'stream recovery failed');
        } else {
          this._logger.warn({ stt: stt.label, error: e }, 'stream recovery unexpected error');
        }
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        const idx = this.recoveringStreams.indexOf(stream);
        if (idx !== -1) {
          this.recoveringStreams.splice(idx, 1);
        }
        try {
          stream.close();
        } catch (e) {
          this._logger.debug({ error: e }, 'error closing recovery stream in finally');
        }
      }
    });
  }
}
