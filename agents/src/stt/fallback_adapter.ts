// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Task, cancelAndWait, combineSignals } from '../utils.js';
import type { VAD } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import type { SpeechEvent } from './stt.js';
import { STT, SpeechEventType, SpeechStream } from './stt.js';

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

interface STTStatus {
  available: boolean;
  recoveringSynthesizeTask: Task<void> | null;
  recoveringStreamTask: Task<void> | null;
}

interface FallbackAdapterOptions {
  sstInstances: STT[];
  vad?: VAD;
  attemptTimeoutMs: number;
  maxRetryPerSTT: number;
  retryIntervalMs: number;
}

export interface AvailabilityChangedEvent {
  stt: STT;
  available: boolean;
}

export class FallbackAdapter extends STT {
  label = 'sst.FallbackAdapter';

  readonly sttInstances: STT[];
  readonly attemptTimeoutMs: number;
  readonly maxRetryPerSTT: number;
  readonly retryIntervalMs: number;

  private _status: STTStatus[];
  private _logger = log();

  constructor(opts: FallbackAdapterOptions) {
    if (!opts.sstInstances || opts.sstInstances.length < 1) {
      throw new Error('At least one STT instance must be provided.');
    }
    let sttInstances = opts.sstInstances!;
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

    this.sttInstances = sttInstances;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 10000;
    this.maxRetryPerSTT = opts.maxRetryPerSTT ?? 1;
    this.retryIntervalMs = opts.retryIntervalMs ?? 5000;
    this._status = sttInstances.map(() => ({
      available: true,
      recoveringSynthesizeTask: null,
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

  private emitAvailabilityChanged(stt: STT, available: boolean): void {
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
      return await stt.recognize(buffer as AudioBuffer, effectiveSignal);
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

    if (sttStatus.recoveringSynthesizeTask && !sttStatus.recoveringSynthesizeTask.done) {
      return;
    }

    sttStatus.recoveringSynthesizeTask = Task.from(async () => {
      try {
        await this.tryRecognize({
          stt,
          buffer,
          connOptions,
          recovering: true,
        });
        sttStatus.available = true;
        this._logger.info({ stt: stt.label }, 'recovered');
        this.emitAvailabilityChanged(stt, true);
      } catch (e) {
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
        try {
          return await this.tryRecognize({
            stt,
            buffer,
            connOptions,
            abortSignal,
            recovering: false,
          });
        } catch {
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
      [s.recoveringSynthesizeTask, s.recoveringStreamTask].filter(
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

class FallbackSpeechStream extends SpeechStream {}
