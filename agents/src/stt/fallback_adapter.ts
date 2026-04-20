// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import type { STTMetrics } from '../metrics/base.js';
import type { APIConnectOptions } from '../types.js';
import { Task, cancelAndWait } from '../utils.js';
import type { VAD } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import {
  STT,
  type STTCallbacks,
  type STTError,
  type SpeechEvent,
  SpeechEventType,
  SpeechStream,
} from './stt.js';

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
 * Options for creating a {@link FallbackAdapter}.
 */
export interface FallbackAdapterOptions {
  /** List of STT instances to use for fallback (in priority order). At least one is required. */
  sttInstances: STT[];
  /**
   * VAD used to auto-wrap non-streaming STTs with {@link StreamAdapter}. Required
   * when any of the supplied STT instances does not support streaming.
   */
  vad?: VAD;
  /** Per-attempt timeout in milliseconds. Defaults to 10000. */
  attemptTimeoutMs?: number;
  /** Number of internal retries per STT instance before moving to the next one. Defaults to 1. */
  maxRetryPerSTT?: number;
  /** Delay in milliseconds between internal retries. Defaults to 5000. */
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

/**
 * `FallbackAdapter` is an STT wrapper that provides automatic failover between
 * multiple STT providers.
 *
 * When the primary STT fails, the adapter switches to the next available
 * provider in the list for the active session. Failed providers are monitored
 * by a parallel probe stream that receives the same live audio — when a probe
 * yields a non-empty FINAL_TRANSCRIPT the provider is marked available again.
 *
 * Non-streaming STTs are automatically wrapped with {@link StreamAdapter}
 * provided a `vad` is passed in.
 *
 * @example
 * ```typescript
 * import { FallbackAdapter } from '@livekit/agents';
 * import { STT as DeepgramSTT } from '@livekit/agents-plugin-deepgram';
 * import { STT as AssemblyAISTT } from '@livekit/agents-plugin-assemblyai';
 *
 * const fallbackSTT = new FallbackAdapter({
 *   sttInstances: [
 *     new AssemblyAISTT(),  // Primary
 *     new DeepgramSTT(),    // Fallback
 *   ],
 * });
 * ```
 */
export class FallbackAdapter extends STT {
  readonly sttInstances: STT[];
  readonly attemptTimeoutMs: number;
  readonly maxRetryPerSTT: number;
  readonly retryIntervalMs: number;

  private _status: STTStatus[] = [];
  private _logger = log();
  private _metricsForwarders = new Map<STT, (m: STTMetrics) => void>();

  label = 'stt.FallbackAdapter';

  constructor(opts: FallbackAdapterOptions) {
    if (!opts.sttInstances || opts.sttInstances.length < 1) {
      throw new Error('at least one STT instance must be provided.');
    }

    const nonStreaming = opts.sttInstances.filter((s) => !s.capabilities.streaming);
    if (nonStreaming.length > 0 && !opts.vad) {
      const labels = nonStreaming.map((s) => s.label).join(', ');
      throw new Error(
        `STTs do not support streaming: ${labels}. ` +
          'Provide a vad to enable stt.StreamAdapter automatically ' +
          'or wrap them with stt.StreamAdapter before using this adapter.',
      );
    }

    const wrapped = opts.sttInstances.map((s) =>
      s.capabilities.streaming ? s : new StreamAdapter(s, opts.vad!),
    );

    // Pick the primary's granularity only if every instance supports aligned
    // transcripts — otherwise consumers can't rely on a consistent format.
    let alignedTranscript: 'word' | 'chunk' | false = false;
    if (wrapped.every((s) => !!s.capabilities.alignedTranscript)) {
      alignedTranscript = wrapped[0]!.capabilities.alignedTranscript ?? false;
    }

    super({
      streaming: true,
      interimResults: wrapped.every((s) => s.capabilities.interimResults),
      diarization: wrapped.every((s) => !!s.capabilities.diarization),
      alignedTranscript,
    });

    this.sttInstances = wrapped;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 10_000;
    this.maxRetryPerSTT = opts.maxRetryPerSTT ?? 1;
    this.retryIntervalMs = opts.retryIntervalMs ?? 5_000;

    this._status = this.sttInstances.map(() => ({
      available: true,
      recoveringRecognizeTask: null,
      recoveringStreamTask: null,
    }));

    this.setupEventForwarding();
  }

  override get model(): string {
    return 'FallbackAdapter';
  }

  override get provider(): string {
    return 'livekit';
  }

  /**
   * Returns the current status of all STT instances, including availability
   * and background recovery state.
   */
  get status(): STTStatus[] {
    return this._status;
  }

  private setupEventForwarding(): void {
    // We intentionally do NOT forward child 'error' events. The adapter's job
    // is to mask transient child failures via fallback — surfacing them to
    // consumers (e.g. AgentSession, which treats any unrecoverable stt_error
    // as a reason to close the session) would defeat the point. Terminal
    // errors still reach the session via the adapter's own run()/recognize()
    // throwing APIConnectionError once every child has failed — the base
    // SpeechStream.mainTask emits that on this STT instance naturally.
    for (const s of this.sttInstances) {
      const metricsForwarder = (metrics: STTMetrics) => this.emit('metrics_collected', metrics);
      this._metricsForwarders.set(s, metricsForwarder);
      s.on('metrics_collected', metricsForwarder);
    }
  }

  emitAvailabilityChanged(stt: STT, available: boolean): void {
    const event: AvailabilityChangedEvent = { stt, available };
    (this as unknown as NodeJS.EventEmitter).emit('stt_availability_changed', event);
  }

  private tryRecoverRecognize(stt: STT, frame: Parameters<STT['recognize']>[0]): void {
    const idx = this.sttInstances.indexOf(stt);
    const status = this._status[idx];
    if (!status) return;
    if (status.recoveringRecognizeTask && !status.recoveringRecognizeTask.done) return;

    status.recoveringRecognizeTask = Task.from(async (controller) => {
      try {
        await stt.recognize(frame, controller.signal);
        status.available = true;
        this._logger.info({ stt: stt.label }, `${stt.label} recovered`);
        this.emitAvailabilityChanged(stt, true);
      } catch (e) {
        if (e instanceof APIError) {
          this._logger.warn({ stt: stt.label, err: e }, `${stt.label} recovery failed`);
        } else {
          this._logger.debug({ stt: stt.label, err: e }, `${stt.label} recovery unexpected error`);
        }
      }
    });
  }

  protected async _recognize(
    frame: Parameters<STT['recognize']>[0],
    abortSignal?: AbortSignal,
  ): Promise<SpeechEvent> {
    const startTime = Date.now();
    const allFailed = this._status.every((s) => !s.available);
    if (allFailed) {
      this._logger.error('all STTs are unavailable, retrying..');
    }

    for (let i = 0; i < this.sttInstances.length; i++) {
      const stt = this.sttInstances[i]!;
      const status = this._status[i]!;
      if (status.available || allFailed) {
        try {
          return await stt.recognize(frame, abortSignal);
        } catch (e) {
          if (e instanceof APIError) {
            this._logger.warn(
              { stt: stt.label, err: e },
              `${stt.label} failed, switching to next STT`,
            );
          } else {
            this._logger.warn(
              { stt: stt.label, err: e },
              `${stt.label} unexpected error, switching to next STT`,
            );
          }
          if (status.available) {
            status.available = false;
            this.emitAvailabilityChanged(stt, false);
          }
        }
      }
      this.tryRecoverRecognize(stt, frame);
    }

    const labels = this.sttInstances.map((s) => s.label).join(', ');
    throw new APIConnectionError({
      message: `all STTs failed (${labels}) after ${Date.now() - startTime}ms`,
    });
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    // The base SpeechStream's mainTask honours its connOptions for its own
    // retry loop, which we disable (maxRetry: 0) because failover is driven
    // by this adapter. timeoutMs/retryIntervalMs here would only apply to
    // that disabled loop — default them to the adapter's knobs anyway so
    // callers that introspect the stream see consistent values.
    return new FallbackSpeechStream(
      this,
      options?.connOptions ?? {
        maxRetry: 0,
        timeoutMs: this.attemptTimeoutMs,
        retryIntervalMs: this.retryIntervalMs,
      },
    );
  }

  override async close(): Promise<void> {
    const tasks: Task<void>[] = [];
    for (const status of this._status) {
      if (status.recoveringRecognizeTask && !status.recoveringRecognizeTask.done) {
        tasks.push(status.recoveringRecognizeTask);
      }
      if (status.recoveringStreamTask && !status.recoveringStreamTask.done) {
        tasks.push(status.recoveringStreamTask);
      }
    }
    if (tasks.length > 0) {
      await cancelAndWait(tasks, 1000);
    }
    for (const s of this.sttInstances) {
      const m = this._metricsForwarders.get(s);
      if (m) s.off('metrics_collected' as keyof STTCallbacks, m);
    }
    this._metricsForwarders.clear();
  }
}

class FallbackSpeechStream extends SpeechStream {
  label = 'stt.FallbackSpeechStream';
  private fallbackAdapter: FallbackAdapter;
  private recoveringStreams: SpeechStream[] = [];
  private _logger = log();

  constructor(adapter: FallbackAdapter, connOptions: APIConnectOptions) {
    super(adapter, undefined, connOptions);
    this.fallbackAdapter = adapter;
  }

  // Skip `metrics_collected` emission in the adapter stream — children's
  // metrics are already forwarded to the adapter via `_metricsForwarders`.
  // Without this override we double-count every RECOGNITION_USAGE event.
  protected override async monitorMetrics(): Promise<void> {
    for await (const event of this.queue) {
      if (!this.output.closed) {
        try {
          this.output.put(event);
        } catch {
          /* queue closed during disconnect — expected */
        }
      }
    }
    if (!this.output.closed) this.output.close();
  }

  private tryRecoverStream(sttInstance: STT): void {
    const idx = this.fallbackAdapter.sttInstances.indexOf(sttInstance);
    const status = this.fallbackAdapter.status[idx];
    if (!status) return;
    if (status.recoveringStreamTask && !status.recoveringStreamTask.done) return;

    const probe = sttInstance.stream({
      connOptions: {
        maxRetry: 0,
        timeoutMs: this.fallbackAdapter.attemptTimeoutMs,
        retryIntervalMs: this.fallbackAdapter.retryIntervalMs,
      },
    });
    this.recoveringStreams.push(probe);

    // Absorb child 'error' events while the probe is active. JS EventEmitter
    // crashes if 'error' fires with no listener; the probe's iterator ends
    // naturally on failure, so we don't need to do anything with the payload.
    const errorSink: (e: STTError) => void = () => {};
    sttInstance.on('error', errorSink);

    status.recoveringStreamTask = Task.from(async (controller) => {
      try {
        let gotTranscript = false;
        for await (const ev of probe) {
          if (controller.signal.aborted) break;
          if (ev.type === SpeechEventType.FINAL_TRANSCRIPT) {
            const text = ev.alternatives?.[0]?.text;
            if (!text) continue;
            gotTranscript = true;
            break;
          }
        }
        if (!gotTranscript) return;
        status.available = true;
        this._logger.info({ stt: sttInstance.label }, `${sttInstance.label} recovered`);
        this.fallbackAdapter.emitAvailabilityChanged(sttInstance, true);
      } catch (e) {
        if (e instanceof APIError) {
          this._logger.warn(
            { stt: sttInstance.label, err: e },
            `${sttInstance.label} recovery failed`,
          );
        } else {
          this._logger.debug(
            { stt: sttInstance.label, err: e },
            `${sttInstance.label} recovery unexpected error`,
          );
        }
      } finally {
        sttInstance.off('error', errorSink);
        probe.close();
        const i = this.recoveringStreams.indexOf(probe);
        if (i >= 0) this.recoveringStreams.splice(i, 1);
      }
    });
  }

  protected async run(): Promise<void> {
    const startTime = Date.now();
    const allFailed = this.fallbackAdapter.status.every((s) => !s.available);
    if (allFailed) {
      this._logger.error('all STTs are unavailable, retrying..');
    }

    // A single forwarder drains this.input and replicates each frame to the
    // currently-elected main stream (mutable via `mainStream` ref) and every
    // parallel probe stream. Fires once; closes main on input EOF.
    // Box mutable refs so the async IIFE closure doesn't narrow the variable
    // type to `never` based on its initial value. TS's control-flow analysis
    // for closures can't always see that outer code reassigns the var.
    const mainRef: { current: SpeechStream | null } = { current: null };
    // Forwarder runs as a Task so we can cancel+await it on terminal failure.
    const forwarderTask = Task.from(async (controller) => {
      for await (const item of this.input) {
        if (controller.signal.aborted || this.abortSignal.aborted) break;
        for (const probe of [...this.recoveringStreams]) {
          try {
            if (typeof item === 'symbol') probe.flush();
            else probe.pushFrame(item);
          } catch {
            // probe closed — next tick will prune it via its own task
          }
        }
        const current = mainRef.current;
        if (current !== null) {
          try {
            if (typeof item === 'symbol') current.flush();
            else current.pushFrame(item);
          } catch (e) {
            this._logger.debug({ err: e }, 'error forwarding input to main stream');
          }
        }
      }
      const endTarget = mainRef.current;
      if (endTarget !== null) {
        try {
          endTarget.endInput();
        } catch {
          /* already ended */
        }
      }
    });

    for (let i = 0; i < this.fallbackAdapter.sttInstances.length; i++) {
      const sttInstance = this.fallbackAdapter.sttInstances[i]!;
      const status = this.fallbackAdapter.status[i]!;
      if (!(status.available || allFailed)) {
        this.tryRecoverStream(sttInstance);
        continue;
      }

      // Capture child errors: the base SpeechStream's mainTask emits an
      // `error` event and then closes its output queue — consumers never
      // see the throw via `for await`. Without this listener we can't
      // distinguish a provider failure from a silent end-of-input.
      let childErrored = false;
      const errListener = (e: STTError) => {
        if (!e.recoverable) childErrored = true;
      };
      sttInstance.on('error', errListener);

      try {
        const child = sttInstance.stream({
          connOptions: {
            maxRetry: this.fallbackAdapter.maxRetryPerSTT,
            timeoutMs: this.fallbackAdapter.attemptTimeoutMs,
            retryIntervalMs: this.fallbackAdapter.retryIntervalMs,
          },
        });
        mainRef.current = child;

        try {
          for await (const ev of child) {
            this.queue.put(ev);
          }
        } finally {
          child.close();
        }

        if (!childErrored) {
          // Main stream ended cleanly (input EOF).
          return;
        }
        if (status.available) {
          status.available = false;
          this.fallbackAdapter.emitAvailabilityChanged(sttInstance, false);
        }
        this._logger.warn(
          { stt: sttInstance.label },
          `${sttInstance.label} failed, switching to next STT`,
        );
      } catch (e) {
        if (e instanceof APIError) {
          this._logger.warn(
            { stt: sttInstance.label, err: e },
            `${sttInstance.label} failed, switching to next STT`,
          );
        } else {
          this._logger.warn(
            { stt: sttInstance.label, err: e },
            `${sttInstance.label} unexpected error, switching to next STT`,
          );
        }
        if (status.available) {
          status.available = false;
          this.fallbackAdapter.emitAvailabilityChanged(sttInstance, false);
        }
      } finally {
        sttInstance.off('error', errListener);
        mainRef.current = null;
      }

      this.tryRecoverStream(sttInstance);
    }

    // Terminal failure: drain + cancel the forwarder and every live probe
    // task before throwing.
    try {
      this.input.close();
    } catch {
      /* already closed */
    }
    if (!forwarderTask.done) {
      await cancelAndWait([forwarderTask], 1000);
    }
    const liveProbeTasks: Task<void>[] = [];
    for (let i = 0; i < this.fallbackAdapter.sttInstances.length; i++) {
      const s = this.fallbackAdapter.status[i];
      if (s?.recoveringStreamTask && !s.recoveringStreamTask.done) {
        liveProbeTasks.push(s.recoveringStreamTask);
      }
    }
    if (liveProbeTasks.length > 0) {
      await cancelAndWait(liveProbeTasks, 1000);
    }
    for (const probe of [...this.recoveringStreams]) {
      try {
        probe.close();
      } catch {
        /* already closed */
      }
    }

    const labels = this.fallbackAdapter.sttInstances.map((s) => s.label).join(', ');
    throw new APIConnectionError({
      message: `all STTs failed (${labels}) after ${Date.now() - startTime}ms`,
    });
  }
}
