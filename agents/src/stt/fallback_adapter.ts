// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import type { STTMetrics } from '../metrics/base.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Task, cancelAndWait } from '../utils.js';
import type { VAD } from '../vad.js';
import type { ConversationItemAddedEvent } from '../voice/events.js';
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
  waitingStreams: Set<FallbackSpeechStream>;
  recoveryClosed: boolean;
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

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

/**
 * Agent Fallback Adapter for STT. Manages multiple STT instances with automatic
 * fallback when the primary provider fails.
 *
 * When the primary STT fails, the adapter switches to the next available
 * provider in the list for the active session. Failed providers are monitored
 * by one probe stream per provider. The probe receives its owner's live audio;
 * another waiting stream takes over if the owner closes. A non-empty
 * FINAL_TRANSCRIPT marks the provider available again.
 * If every provider is unavailable, normal streams retry them in priority order.
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
      keyterms: wrapped.some((s) => !!s.capabilities.keyterms),
      chatContext: wrapped.some((s) => !!s.capabilities.chatContext),
    });

    this.sttInstances = wrapped;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 10_000;
    this.maxRetryPerSTT = opts.maxRetryPerSTT ?? 1;
    this.retryIntervalMs = opts.retryIntervalMs ?? 5_000;

    this._status = this.sttInstances.map(() => ({
      available: true,
      recoveringRecognizeTask: null,
      recoveringStreamTask: null,
      waitingStreams: new Set<FallbackSpeechStream>(),
      recoveryClosed: false,
    }));

    this.setupEventForwarding();
  }

  // Reflect the active child's model/provider so OTel `gen_ai.request.model`
  // and `gen_ai.provider.name` on `user_turn` spans identify the provider
  // that actually transcribed, not the static wrapper. `audio_recognition.
  // refreshUserTurnSttAttributes` re-reads these on every STT event, so a
  // mid-turn fallover surfaces the new child immediately.
  /**
   * The instance the next request goes to first: the first one marked available, or the primary
   * once all are down (they are then all retried, primary first). A failed instance's recovery
   * task flips it back to available, so a recovered primary is reported again before it has
   * served.
   */
  private nextInstance(): STT {
    const index = this._status.findIndex((status) => status.available);
    return this.sttInstances[index === -1 ? 0 : index]!;
  }

  /**
   * The model of the instance that serves next (see `nextInstance`). Spans and metrics read
   * this, so a failover shows the model expected to answer rather than the adapter.
   */
  override get model(): string {
    return this.nextInstance().model;
  }

  /** The provider of the instance that serves next (see {@link model}). */
  override get provider(): string {
    return this.nextInstance().provider;
  }

  /**
   * Returns the current status of all STT instances, including availability
   * and background recovery state.
   */
  get status(): STTStatus[] {
    return this._status;
  }

  override _updateSessionKeyterms(keyterms: string[]): void {
    // forward to every underlying STT; unsupported ones warn-and-skip internally
    for (const sttInstance of this.sttInstances) {
      sttInstance._updateSessionKeyterms(keyterms);
    }
  }

  override _pushConversationItem(ev: ConversationItemAddedEvent): void {
    // forward to every underlying STT; unsupported ones warn-and-skip internally
    for (const sttInstance of this.sttInstances) {
      sttInstance._pushConversationItem(ev);
    }
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
    if (!status || status.recoveryClosed) return;
    if (status.recoveringRecognizeTask && !status.recoveringRecognizeTask.done) return;

    const task = Task.from(async (controller) => {
      try {
        await stt.recognize(frame, controller.signal);
        if (controller.signal.aborted || status.recoveryClosed) return;
        status.available = true;
        this._logger.info({ stt: stt.label }, 'STT recovered');
        this.emitAvailabilityChanged(stt, true);
      } catch (e) {
        if (controller.signal.aborted || status.recoveryClosed) return;
        if (e instanceof APIError) {
          this._logger.warn(
            { stt: stt.label, errorType: e instanceof Error ? e.constructor.name : typeof e },
            'STT recovery failed',
          );
        } else {
          this._logger.debug(
            { stt: stt.label, errorType: e instanceof Error ? e.constructor.name : typeof e },
            'STT recovery failed',
          );
        }
      }
    });
    status.recoveringRecognizeTask = task;
    task.addDoneCallback(() => {
      if (status.recoveringRecognizeTask === task) status.recoveringRecognizeTask = null;
    });
  }

  // Skip the base class's `metrics_collected` emit: the active child's own
  // `recognize()` already emits metrics, and those are forwarded onto the
  // adapter by `setupEventForwarding`. Without this override, consumers see
  // each RECOGNITION_USAGE event twice and `audioDurationMs` is double-counted.
  // Mirrors the streaming path's `monitorMetrics` override.
  override async recognize(
    frame: Parameters<STT['recognize']>[0],
    abortSignal?: AbortSignal,
  ): Promise<SpeechEvent> {
    return this._recognize(frame, abortSignal);
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
          const result = await stt.recognize(frame, abortSignal);
          return result;
        } catch (e) {
          this._logger.warn(
            { stt: stt.label, errorType: e instanceof Error ? e.constructor.name : typeof e },
            'STT failed, switching to next provider',
          );
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
    return new FallbackSpeechStream(
      this,
      options?.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
    );
  }

  override async close(): Promise<void> {
    const tasks: Task<void>[] = [];
    for (const status of this._status) {
      status.recoveryClosed = true;
      status.waitingStreams.clear();
      if (status.recoveringRecognizeTask && !status.recoveringRecognizeTask.done) {
        tasks.push(status.recoveringRecognizeTask);
      }
      if (status.recoveringStreamTask) tasks.push(status.recoveringStreamTask);
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
  private recoveringStreams = new Map<SpeechStream, Task<void>>();
  private inputEnded = false;
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

  private tryRecoverStream(sttInstance: STT): boolean {
    if (this.abortSignal.aborted) return false;
    const idx = this.fallbackAdapter.sttInstances.indexOf(sttInstance);
    const status = this.fallbackAdapter.status[idx];
    if (!status || status.available || status.recoveryClosed) return false;
    if (status.recoveringStreamTask && !status.recoveringStreamTask.done) {
      status.waitingStreams.add(this);
      return false;
    }
    status.waitingStreams.delete(this);

    let probe: SpeechStream;
    try {
      probe = sttInstance.stream({
        connOptions: {
          maxRetry: 0,
          timeoutMs: this.fallbackAdapter.attemptTimeoutMs,
          retryIntervalMs: this.fallbackAdapter.retryIntervalMs,
        },
      });
    } catch (error) {
      this._logger.warn(
        {
          stt: sttInstance.label,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        },
        'STT recovery failed',
      );
      return false;
    }
    const closeProbe = () => {
      try {
        probe.close();
      } catch {
        /* already closed */
      }
    };
    if (this.abortSignal.aborted || status.recoveryClosed) {
      closeProbe();
      return false;
    }

    // Absorb provider error events; each probe records its own terminal outcome.
    const errorSink: (e: STTError) => void = () => {};
    sttInstance.on('error', errorSink);

    const task = Task.from(async (controller) => {
      controller.signal.addEventListener('abort', closeProbe, { once: true });
      try {
        let recovered = false;
        for await (const ev of probe) {
          if (controller.signal.aborted || this.abortSignal.aborted) break;
          if (ev.type === SpeechEventType.FINAL_TRANSCRIPT) {
            const text = ev.alternatives?.[0]?.text;
            if (!text) continue;
            recovered = true;
            break;
          }
        }
        if (
          !recovered ||
          controller.signal.aborted ||
          this.abortSignal.aborted ||
          status.recoveryClosed
        )
          return;
        if (!status.available) {
          status.available = true;
          this._logger.info({ stt: sttInstance.label }, 'STT recovered');
          this.fallbackAdapter.emitAvailabilityChanged(sttInstance, true);
        }
      } catch (e) {
        if (controller.signal.aborted || this.abortSignal.aborted) return;
        if (e instanceof APIError) {
          this._logger.warn(
            {
              stt: sttInstance.label,
              errorType: e instanceof Error ? e.constructor.name : typeof e,
            },
            'STT recovery failed',
          );
        } else {
          this._logger.debug(
            {
              stt: sttInstance.label,
              errorType: e instanceof Error ? e.constructor.name : typeof e,
            },
            'STT recovery failed',
          );
        }
      } finally {
        controller.signal.removeEventListener('abort', closeProbe);
        sttInstance.off('error', errorSink);
        closeProbe();
      }
    });
    this.recoveringStreams.set(probe, task);
    status.recoveringStreamTask = task;
    task.addDoneCallback(() => {
      this.recoveringStreams.delete(probe);
      if (status.recoveringStreamTask !== task) return;
      status.recoveringStreamTask = null;
      if (status.available || status.recoveryClosed) {
        status.waitingStreams.clear();
        return;
      }
      for (const stream of status.waitingStreams) {
        status.waitingStreams.delete(stream);
        if (stream.tryRecoverStream(sttInstance)) break;
      }
    });
    if (this.inputEnded) {
      try {
        probe.endInput();
      } catch {
        closeProbe();
      }
    }
    return true;
  }

  protected async run(): Promise<void> {
    if (this.abortSignal.aborted) return;
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
        for (const probe of this.recoveringStreams.keys()) {
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
            this._logger.debug(
              { errorType: e instanceof Error ? e.constructor.name : typeof e },
              'error forwarding input to main stream',
            );
          }
        }
      }
      this.inputEnded = true;
      for (const endTarget of [mainRef.current, ...this.recoveringStreams.keys()]) {
        try {
          endTarget?.endInput();
        } catch {
          /* already ended */
        }
      }
    });

    const closeStreams = () => {
      for (const status of this.fallbackAdapter.status) status.waitingStreams.delete(this);
      for (const task of this.recoveringStreams.values()) {
        task.cancel();
      }
      for (const stream of [mainRef.current, ...this.recoveringStreams.keys()]) {
        try {
          stream?.close();
        } catch {
          // Continue closing the remaining streams if a provider throws.
        }
      }
    };

    this.abortSignal.addEventListener('abort', closeStreams, { once: true });
    try {
      for (let i = 0; i < this.fallbackAdapter.sttInstances.length; i++) {
        if (this.abortSignal.aborted) return;
        const sttInstance = this.fallbackAdapter.sttInstances[i]!;
        const status = this.fallbackAdapter.status[i]!;
        if (!status.available && !allFailed) {
          this.tryRecoverStream(sttInstance);
          continue;
        }

        // Absorb provider errors here; the child records its own terminal outcome.
        const errListener = () => {};
        sttInstance.on('error', errListener);

        try {
          const child = sttInstance.stream({
            connOptions: {
              maxRetry: this.fallbackAdapter.maxRetryPerSTT,
              timeoutMs: this.fallbackAdapter.attemptTimeoutMs,
              retryIntervalMs: this.fallbackAdapter.retryIntervalMs,
            },
          });
          // Keep child timestamps anchored to the parent stream's current retry attempt.
          child.startTimeOffset = this.startTimeOffset + (Date.now() - startTime) / 1000;
          mainRef.current = child;
          try {
            if (this.abortSignal.aborted) return;
            // If the forwarder has already drained and exited (input EOF), it
            // will never call endInput() on this child. End it here so the
            // child's `for await (input)` loop can terminate cleanly instead
            // of hanging forever.
            if (this.inputEnded) {
              try {
                child.endInput();
              } catch {
                /* already ended */
              }
            }

            for await (const ev of child) {
              // The parent can close while a child has a transcript in flight.
              // Stop cleanly instead of treating the closed queue as a provider failure.
              if (this.abortSignal.aborted || this.queue.closed) {
                return;
              }
              this.queue.put(ev);
            }
          } finally {
            child.close();
          }

          if (this.abortSignal.aborted || (!child._failed && this.inputEnded)) {
            return;
          }
          if (status.available) {
            status.available = false;
            this.fallbackAdapter.emitAvailabilityChanged(sttInstance, false);
          }
          this._logger.warn({ stt: sttInstance.label }, 'STT failed, switching to next provider');
        } catch (e) {
          if (this.abortSignal.aborted) return;
          this._logger.warn(
            {
              stt: sttInstance.label,
              errorType: e instanceof Error ? e.constructor.name : typeof e,
            },
            'STT failed, switching to next provider',
          );
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

      if (this.abortSignal.aborted) return;
      const labels = this.fallbackAdapter.sttInstances.map((s) => s.label).join(', ');
      throw new APIConnectionError({
        message: `all STTs failed (${labels}) after ${Date.now() - startTime}ms`,
      });
    } finally {
      this.abortSignal.removeEventListener('abort', closeStreams);
      if (!this.input.closed) this.input.close();
      const tasks = [forwarderTask, ...this.recoveringStreams.values()];
      closeStreams();
      await cancelAndWait(tasks, 1000);
    }
  }
}
