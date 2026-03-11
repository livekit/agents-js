// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import type { AudioBuffer } from '../utils.js';
import { Task, cancelAndWait, combineSignals } from '../utils.js';
import type { VAD } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import type { STTError, STTRecognizeOptions, STTStreamOptions, SpeechEvent } from './stt.js';
import { STT, SpeechEventType, SpeechStream } from './stt.js';

/**
 * Internal status tracking for each STT instance.
 * @internal
 */
interface STTStatus {
  available: boolean;
  recoveringRecognizeTask: Task<void> | null;
  recoveringStreamTask: Task<void> | null;
}

/**
 * Options for creating a FallbackAdapter.
 */
export interface FallbackAdapterOptions {
  /** List of STT instances to use for fallback (in priority order). At least one is required. */
  sttInstances: STT[];
  /**
   * Optional VAD used to wrap non-streaming STTs with `stt.StreamAdapter`.
   * Required when any provider does not support streaming.
   */
  vad?: VAD;
  /** Timeout in milliseconds for each individual STT attempt. Defaults to 5000. */
  attemptTimeoutMs?: number;
  /** Number of retries per STT instance before falling back to the next one. Defaults to 1. */
  maxRetryPerSTT?: number;
  /** Delay in milliseconds between retries for a single STT instance. Defaults to 1000. */
  retryIntervalMs?: number;
}

/**
 * Event emitted when an STT instance's availability changes.
 */
export interface AvailabilityChangedEvent {
  /** The STT instance whose availability changed. */
  stt: STT;
  /** Whether the STT instance is now available. */
  available: boolean;
}

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 22-25 lines
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

/**
 * FallbackAdapter is an STT wrapper that provides automatic failover between multiple STT providers.
 *
 * When the current provider fails, it switches to the next available provider in priority order.
 * Failed providers are probed in the background and automatically restored when they recover.
 *
 * Features:
 * - Automatic failover to backup STT providers on failure
 * - Background recovery probes for failed providers
 * - Support for mixed streaming and non-streaming STTs when a VAD is supplied
 * - Per-provider retry budgets without a second retry loop at the fallback layer
 *
 * @example
 * ```typescript
 * import { FallbackAdapter } from '@livekit/agents';
 * import { STT as DeepgramSTT } from '@livekit/agents-plugin-deepgram';
 * import { STT as OpenAISTT } from '@livekit/agents-plugin-openai';
 *
 * const fallbackSTT = new FallbackAdapter({
 *   sttInstances: [
 *     new DeepgramSTT(), // Primary
 *     new OpenAISTT(),   // Fallback
 *   ],
 *   maxRetryPerSTT: 1,
 *   attemptTimeoutMs: 5000,
 *   retryIntervalMs: 1000,
 * });
 * ```
 */
export class FallbackAdapter extends STT {
  /** The list of STT instances used for fallback (in priority order). */
  readonly sttInstances: STT[];
  /** Timeout in milliseconds for each individual STT attempt. */
  readonly attemptTimeoutMs: number;
  /** Number of retries per STT instance before falling back to the next one. */
  readonly maxRetryPerSTT: number;
  /** Delay in milliseconds between retries for a single STT instance. */
  readonly retryIntervalMs: number;

  private _status: STTStatus[];
  private _logger = log();
  private _metricsHandlers = new Map<STT, (metrics: unknown) => void>();
  private _errorHandlers = new Map<STT, (error: STTError) => void>();

  label = 'stt.FallbackAdapter';

  constructor(opts: FallbackAdapterOptions) {
    if (!opts.sttInstances || opts.sttInstances.length < 1) {
      throw new Error('at least one STT instance must be provided.');
    }

    let sttInstances = opts.sttInstances;
    const nonStreaming = sttInstances.filter((stt) => !stt.capabilities.streaming);
    if (nonStreaming.length > 0) {
      if (!opts.vad) {
        const labels = nonStreaming.map((stt) => stt.label).join(', ');
        throw new Error(
          `STTs do not support streaming: ${labels}. ` +
            'Provide a VAD to enable stt.StreamAdapter automatically ' +
            'or wrap them with stt.StreamAdapter before using this adapter.',
        );
      }

      sttInstances = sttInstances.map((stt) =>
        stt.capabilities.streaming ? stt : new StreamAdapter(stt, opts.vad!),
      );
    }

    if (opts.attemptTimeoutMs !== undefined && opts.attemptTimeoutMs <= 0) {
      throw new Error('attemptTimeoutMs must be a positive number.');
    }
    if (opts.maxRetryPerSTT !== undefined && opts.maxRetryPerSTT < 0) {
      throw new Error('maxRetryPerSTT must be a non-negative number.');
    }
    if (opts.retryIntervalMs !== undefined && opts.retryIntervalMs < 0) {
      throw new Error('retryIntervalMs must be a non-negative number.');
    }

    // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 53-95 lines
    super({
      streaming: true,
      interimResults: sttInstances.every((stt) => stt.capabilities.interimResults),
      offlineRecognize: sttInstances.some((stt) => supportsOfflineRecognize(stt)),
      alignedTranscript: combineAlignedTranscript(sttInstances),
    });

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

  // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 93-95 lines
  protected override get recognizeMetricsEnabled(): boolean {
    return false;
  }

  /**
   * Returns the current status of all STT instances, including availability and recovery state.
   */
  get status(): STTStatus[] {
    return this._status;
  }

  /**
   * Emit an availability change event for a child STT instance.
   */
  // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 188-193 lines
  emitAvailabilityChanged(stt: STT, available: boolean): void {
    const event: AvailabilityChangedEvent = { stt, available };
    (this as unknown as { emit: (event: string, data: AvailabilityChangedEvent) => void }).emit(
      'stt_availability_changed',
      event,
    );
  }

  private setupEventForwarding(): void {
    this.sttInstances.forEach((stt) => {
      const metricsHandler = (metrics: unknown) => this.emit('metrics_collected', metrics);
      const errorHandler = (error: STTError) => this.emit('error', error);
      this._metricsHandlers.set(stt, metricsHandler);
      this._errorHandlers.set(stt, errorHandler);
      stt.on('metrics_collected', metricsHandler);
      stt.on('error', errorHandler);
    });
  }

  private async tryRecognize({
    stt,
    buffer,
    options,
    recovering = false,
  }: {
    stt: STT;
    buffer: AudioBuffer;
    options: STTRecognizeOptions;
    recovering?: boolean;
  }): Promise<SpeechEvent> {
    // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 105-162 lines
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.attemptTimeoutMs);
    const abortSignal = options.abortSignal
      ? combineSignals(options.abortSignal, timeoutController.signal)
      : timeoutController.signal;

    try {
      return await stt.recognize(buffer, {
        abortSignal,
        language: options.language,
        connOptions: {
          ...(options.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS),
          maxRetry: this.maxRetryPerSTT,
          timeoutMs: this.attemptTimeoutMs,
          retryIntervalMs: this.retryIntervalMs,
        },
      });
    } catch (error) {
      if (recovering) {
        if (error instanceof APIError) {
          this._logger.warn({ stt: stt.label, error }, 'recognize recovery failed');
        } else {
          this._logger.warn({ stt: stt.label, error }, 'recognize recovery unexpected error');
        }
      } else if (error instanceof APIError) {
        this._logger.warn({ stt: stt.label, error }, 'failed, switching to next STT');
      } else {
        this._logger.warn({ stt: stt.label, error }, 'unexpected error, switching to next STT');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private tryRecoverRecognize({
    stt,
    buffer,
    options,
  }: {
    stt: STT;
    buffer: AudioBuffer;
    options: STTRecognizeOptions;
  }): void {
    // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 164-198 lines
    if (!supportsOfflineRecognize(stt)) {
      return;
    }

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
          options: {
            ...options,
            abortSignal: controller.signal,
          },
          recovering: true,
        });
        sttStatus.available = true;
        this._logger.info({ stt: stt.label }, 'recovered');
        this.emitAvailabilityChanged(stt, true);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        this._logger.debug({ stt: stt.label, error }, 'recognize recovery attempt failed');
      }
    });
  }

  protected async _recognize(
    buffer: AudioBuffer,
    options?: STTRecognizeOptions,
  ): Promise<SpeechEvent> {
    // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 200-245 lines
    const startTime = Date.now();
    const recognizeOptions = options ?? {};
    const candidateIndices = this.getRecognizeCandidateIndices();

    if (candidateIndices.length === 0) {
      throw new APIConnectionError({
        message: 'FallbackAdapter recognize() requires at least one STT with offline recognition.',
        options: { retryable: false },
      });
    }

    const allFailed = candidateIndices.every((index) => !this._status[index]!.available);
    if (allFailed) {
      this._logger.error('all offline-recognize STTs are unavailable, retrying...');
    }

    for (const index of candidateIndices) {
      const stt = this.sttInstances[index]!;
      const sttStatus = this._status[index]!;

      if (sttStatus.available || allFailed) {
        try {
          return await this.tryRecognize({
            stt,
            buffer,
            options: {
              ...recognizeOptions,
              connOptions: recognizeOptions.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
            },
          });
        } catch {
          if (sttStatus.available) {
            sttStatus.available = false;
            this.emitAvailabilityChanged(stt, false);
          }
        }
      }

      this.tryRecoverRecognize({
        stt,
        buffer,
        options: {
          ...recognizeOptions,
          connOptions: recognizeOptions.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
        },
      });
    }

    const labels = candidateIndices.map((index) => this.sttInstances[index]!.label).join(', ');
    throw new APIConnectionError({
      message: `all STTs failed (${labels}) after ${Date.now() - startTime}ms`,
    });
  }

  /**
   * Create a fallback speech stream that can fail over between STT providers.
   */
  stream(options?: STTStreamOptions): SpeechStream {
    // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 247-253 lines
    return new FallbackSpeechStream(
      this,
      options?.language,
      options?.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
    );
  }

  /**
   * Close the FallbackAdapter and all underlying STT instances.
   * This cancels any ongoing recovery tasks and cleans up resources.
   */
  async close(): Promise<void> {
    // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 255-267 lines
    const tasks = this._status.flatMap((status) =>
      [status.recoveringRecognizeTask, status.recoveringStreamTask].filter(
        (task): task is Task<void> => task !== null,
      ),
    );

    if (tasks.length > 0) {
      await cancelAndWait(tasks, 1000);
    }

    for (const stt of this.sttInstances) {
      const metricsHandler = this._metricsHandlers.get(stt);
      const errorHandler = this._errorHandlers.get(stt);
      if (metricsHandler) {
        stt.off('metrics_collected', metricsHandler);
      }
      if (errorHandler) {
        stt.off('error', errorHandler);
      }
    }

    await Promise.all(this.sttInstances.map((stt) => stt.close()));
  }

  private getRecognizeCandidateIndices(): number[] {
    return this.sttInstances.reduce<number[]>((indices, stt, index) => {
      if (supportsOfflineRecognize(stt)) {
        indices.push(index);
      }
      return indices;
    }, []);
  }
}

class FallbackSpeechStream extends SpeechStream {
  label = 'stt.FallbackSpeechStream';

  private adapter: FallbackAdapter;
  private connOptions: APIConnectOptions;
  private language?: string;
  private _logger = log();
  private recoveringStreams: SpeechStream[] = [];

  constructor(adapter: FallbackAdapter, language: string | undefined, connOptions: APIConnectOptions) {
    super(adapter, undefined, connOptions);
    this.adapter = adapter;
    this.language = language;
    this.connOptions = connOptions;
  }

  protected override async monitorMetrics(): Promise<void> {
    await super.monitorMetrics();
  }

  private cleanupRecoveringStreams(): void {
    const streams = this.recoveringStreams;
    this.recoveringStreams = [];
    for (const stream of streams) {
      try {
        stream.close();
      } catch (error) {
        this._logger.debug({ error }, 'error closing recovering stream');
      }
    }
  }

  protected async run(): Promise<void> {
    // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 283-379 lines
    const startTime = Date.now();
    const allFailed = this.adapter.status.every((status) => !status.available);
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
            } catch (error) {
              if (!(error instanceof Error && error.message.includes('closed'))) {
                this._logger.warn({ error }, 'error forwarding input to recovering stream');
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
            } catch (error) {
              if (!(error instanceof Error && error.message.includes('closed'))) {
                this._logger.warn({ error }, 'error forwarding input to main stream');
              }
            }
          }
        }
      } finally {
        forwardInputDone = true;
        if (mainStream) {
          try {
            mainStream.endInput();
          } catch (error) {
            this._logger.debug({ error }, 'error ending main stream input');
          }
        }
        for (const stream of [...this.recoveringStreams]) {
          try {
            stream.endInput();
          } catch (error) {
            this._logger.debug({ error }, 'error ending recovering stream input');
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
            // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 323-330 lines
            mainStream = stt.stream({
              language: this.language,
              connOptions: {
                ...this.connOptions,
                maxRetry: this.adapter.maxRetryPerSTT,
                timeoutMs: this.adapter.attemptTimeoutMs,
                retryIntervalMs: this.adapter.retryIntervalMs,
              },
            });

            if (this.input.closed) {
              mainStream.endInput();
            } else if (!forwardInputTask || forwardInputDone) {
              forwardInputTask = forwardInput();
            }

            let streamError: unknown = null;
            let sawEvent = false;
            const captureStreamError = (error: STTError) => {
              streamError = error.error;
            };
            stt.once('error', captureStreamError);
            try {
              for await (const event of mainStream) {
                sawEvent = true;
                this.queue.put(event);
              }
            } finally {
              stt.off('error', captureStreamError);
            }

            // Child streams can emit their terminal error on a later turn than the
            // iterator completion because their main task runs in the background.
            await new Promise((resolve) => setTimeout(resolve, 0));

            if (streamError !== null) {
              if (streamError instanceof APIError) {
                this._logger.warn({ stt: stt.label, error: streamError }, 'failed, switching to next STT');
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

            if (!sawEvent) {
              throw new APIConnectionError({
                message: this.input.closed
                  ? `${stt.label} stream completed without emitting any events`
                  : `${stt.label} stream ended before any events were emitted`,
              });
            }

            this.cleanupRecoveringStreams();
            return;
          } catch (error) {
            if (!(error instanceof APIError) && !(error instanceof APIConnectionError)) {
              this._logger.warn({ stt: stt.label, error }, 'unexpected error in stream loop');
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
      const labels = this.adapter.sttInstances.map((stt) => stt.label).join(', ');
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
    }
  }

  private tryStreamRecovery(stt: STT): void {
    // Ref: python livekit-agents/livekit/agents/stt/fallback_adapter.py - 381-437 lines
    const index = this.adapter.sttInstances.indexOf(stt);
    const sttStatus = this.adapter.status[index]!;
    if (sttStatus.recoveringStreamTask && !sttStatus.recoveringStreamTask.done) {
      this._logger.debug({ stt: stt.label }, 'stream recovery already in progress, skipping');
      return;
    }

    const stream = stt.stream({
      language: this.language,
      connOptions: {
        ...this.connOptions,
        maxRetry: 0,
        timeoutMs: this.adapter.attemptTimeoutMs,
        retryIntervalMs: this.adapter.retryIntervalMs,
      },
    });
    this.recoveringStreams.push(stream);

    sttStatus.recoveringStreamTask = Task.from(async (controller) => {
      const onAbort = () => stream.close();
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        let transcriptCount = 0;
        for await (const event of stream) {
          if (controller.signal.aborted) {
            break;
          }
          if (event.type === SpeechEventType.FINAL_TRANSCRIPT) {
            if (!event.alternatives || !event.alternatives[0]?.text) {
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
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof APIError) {
          this._logger.warn({ stt: stt.label, error }, 'stream recovery failed');
        } else {
          this._logger.warn({ stt: stt.label, error }, 'stream recovery unexpected error');
        }
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        const streamIndex = this.recoveringStreams.indexOf(stream);
        if (streamIndex !== -1) {
          this.recoveringStreams.splice(streamIndex, 1);
        }
        try {
          stream.close();
        } catch (error) {
          this._logger.debug({ error }, 'error closing recovery stream in finally');
        }
      }
    });
  }
}

function supportsOfflineRecognize(stt: STT): boolean {
  return stt.capabilities.offlineRecognize !== false;
}

function combineAlignedTranscript(sttInstances: STT[]): 'word' | 'chunk' | false {
  const alignedValues = sttInstances.map((stt) => stt.capabilities.alignedTranscript ?? false);
  if (alignedValues.every((value) => value === 'word')) {
    return 'word';
  }
  if (alignedValues.every((value) => value === 'chunk')) {
    return 'chunk';
  }
  return false;
}
