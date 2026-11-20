// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioResampler } from '@livekit/rtc-node';
import { type Throws, ThrowsPromise } from '@livekit/throws-transformer/throws';
import { type Attributes, type Span, trace } from '@opentelemetry/api';
import { AsyncLocalStorage } from 'node:async_hooks';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import type { TTSMetrics } from '../metrics/base.js';
import * as traceTypes from '../telemetry/trace_types.js';
import { blingfire } from '../tokenize/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Task, cancelAndWait, toError } from '../utils.js';
import { StreamAdapter } from './stream_adapter.js';
import {
  ChunkedStream,
  type FallbackActivatedEvent,
  SynthesizeStream,
  TTS,
  type TTSCapabilities,
} from './tts.js';

/**
 * Internal status tracking for each TTS instance.
 * @internal
 */
interface TTSStatus {
  available: boolean;
  /** The recovery probe in flight (or the last one that ran), see `FallbackAdapter.tryRecovery`. */
  recoveringTask: Task<void> | null;
  /** When the last recovery probe started, on the `performance.now()` clock. */
  lastProbeStartedAt?: number;
  /** User attempts in flight: a notice outside any attempt (and outside a probe) is not forwarded. */
  serving: number;
}

/**
 * Options for creating a FallbackAdapter.
 */
export interface FallbackAdapterOptions {
  /** List of TTS instances to use for fallback (in priority order). At least one is required. */
  ttsInstances: TTS[];
  /** Number of internal retries per TTS instance before moving to the next one. Defaults to 2. */
  maxRetryPerTTS?: number;
  /**
   * Minimum interval in milliseconds between the starts of recovery probes for one failed TTS
   * instance. A probe starts when a request skips or fails over the instance, never on a timer,
   * so an idle adapter sends no probes. Defaults to 1000.
   */
  recoveryDelayMs?: number;
}

/**
 * Event emitted when a TTS instance's availability changes.
 */
export interface AvailabilityChangedEvent {
  /** The TTS instance whose availability changed. */
  tts: TTS;
  /** Whether the TTS instance is now available. */
  available: boolean;
}

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

/**
 * The options of the adapter's own stream. Its `maxRetry` is forced to 0: the adapter fails over
 * between instances itself, and each instance retries on its own `maxRetryPerTTS`, so a caller's
 * `maxRetry` (3 in an `AgentSession`) would rerun the whole failover and try every instance
 * `maxRetry + 1` times per request.
 */
function adapterConnOptions(connOptions?: APIConnectOptions): APIConnectOptions {
  return { ...(connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS), maxRetry: 0 };
}

const FORWARD_POLL_MS = 10;

/**
 * Set while a recovery probe's body runs. Everything the probe starts (its stream, the provider
 * connection tasks, their event emitters) inherits it, so the notice forwarder can tell a probe's
 * `fallback_activated` from a user attempt's even when both run on one instance at once. The
 * Python adapter does the same with its `_in_recovery_probe` ContextVar.
 */
const inRecoveryProbe = new AsyncLocalStorage<true>();

/** What a recovery probe synthesizes: short, so a probe costs next to nothing. */
const RECOVERY_PROBE_TEXT = 'Hello world, this is a recovery test.';
/** A probe that has not finished by then counts as failed. */
const RECOVERY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Agent Fallback Adapter for TTS. Manages multiple TTS instances, providing automatic fallback between providers.
 *
 * When the primary TTS fails, it automatically switches to the next available provider in the list.
 * A failed provider is marked unavailable and probed in the background by the next requests that
 * skip or fail over it, and restored once a probe succeeds or it serves a request with audio.
 * A request never fails while a provider remains untried: when every provider it tried has failed,
 * it tries the ones it skipped as unavailable, in priority order, as a last resort. This holds
 * when every provider is down too: each is skipped and probed, then tried in turn, and the one
 * that serves is restored. The adapter reruns no provider on the caller's `maxRetry`: each is tried
 * once per request, with its own `maxRetryPerTTS` retries. A provider that fails after its audio
 * started ends the utterance
 * (another provider would replay it) and is marked unavailable too; the adapter then emits an
 * `error` event, recoverable when the adapter has another provider to serve the next utterance and
 * unrecoverable when it has only one.
 *
 * Known limitation: a provider without a working `synthesize()`, such as `inference.TTS`, fails
 * over on every chunked `synthesize()` request, as any provider bug does. Its recovery probe uses
 * `stream()`, which works, so it is marked unavailable by each chunked request and restored by the
 * next probe or request. Its streaming requests are unaffected. The adapter can't tell "not
 * implemented" from a plugin bug without matching the error message, so it doesn't try.
 *
 * Features:
 * - Automatic failover to backup TTS providers on any failure
 * - Request-driven background probes to restore recovered providers
 * - Automatic audio resampling when TTS providers have different sample rates
 * - Support for both streaming and non-streaming TTS providers
 *
 * @example
 * ```typescript
 * import { FallbackAdapter } from '@livekit/agents';
 * import { TTS as OpenAITTS } from '@livekit/agents-plugin-openai';
 * import { TTS as ElevenLabsTTS } from '@livekit/agents-plugin-elevenlabs';
 *
 * const fallbackTTS = new FallbackAdapter({
 *   ttsInstances: [
 *     new OpenAITTS(),      // Primary
 *     new ElevenLabsTTS(),  // Fallback
 *   ],
 *   maxRetryPerTTS: 2,      // Retry each TTS twice before moving to next
 *   recoveryDelayMs: 1000,  // Probe a failed TTS at most once per second
 * });
 *
 * ```
 */
export class FallbackAdapter extends TTS {
  /** The list of TTS instances used for fallback (in priority order). */
  readonly ttsInstances: TTS[];
  /** Number of retries per TTS instance before falling back to the next one. */
  readonly maxRetryPerTTS: number;
  /** Minimum interval in milliseconds between the starts of recovery probes for one failed TTS instance. */
  readonly recoveryDelayMs: number;

  private _status: TTSStatus[] = [];
  private _logger = log();
  private closed = false;

  label: string = `tts.FallbackAdapter`;

  /**
   * The instance the next request goes to first: the first one marked available, or the primary
   * once all are down (they are then all retried, primary first). A failed instance's recovery
   * task flips it back to available, so a recovered primary is reported again before it has
   * served.
   */
  private nextInstance(): TTS {
    const index = this._status.findIndex((status) => status.available);
    return this.ttsInstances[index === -1 ? 0 : index]!;
  }

  /**
   * The model of the instance that serves next (see `nextInstance`). Spans and metrics read
   * this, so a failover shows the model expected to answer rather than the adapter; the instance
   * that actually served is stamped per request by the stream.
   */
  override get model(): string {
    return this.nextInstance().model;
  }

  /** The provider of the instance that serves next (see {@link model}). */
  override get provider(): string {
    return this.nextInstance().provider;
  }

  constructor(opts: FallbackAdapterOptions) {
    if (!opts.ttsInstances || opts.ttsInstances.length < 1) {
      throw new Error('at least one TTS instance must be provided.');
    }
    const numChannels = opts.ttsInstances[0]!.numChannels;
    const allNumChannelsMatch = opts.ttsInstances.every((tts) => tts.numChannels === numChannels);
    if (!allNumChannelsMatch) {
      throw new Error('All TTS instances should have the same number of channels');
    }
    const sampleRate = Math.max(...opts.ttsInstances.map((t) => t.sampleRate));
    const capabilities = FallbackAdapter.aggregateCapabilities(opts.ttsInstances);
    super(sampleRate, numChannels, capabilities);
    this.ttsInstances = opts.ttsInstances;
    this.maxRetryPerTTS = opts.maxRetryPerTTS ?? 2;
    this.recoveryDelayMs = opts.recoveryDelayMs ?? 1000;
    this._status = opts.ttsInstances.map(() => ({
      available: true,
      recoveringTask: null,
      serving: 0,
    }));
    this.setupEventForwarding();
  }
  private static aggregateCapabilities(instances: TTS[]): TTSCapabilities {
    const streaming = instances.some((tts) => tts.capabilities.streaming);
    const alignedTranscript = instances.every((tts) => tts.capabilities.alignedTranscript === true);
    return { streaming, alignedTranscript };
  }

  private readonly forwardMetrics = (metrics: TTSMetrics) => {
    this.emit('metrics_collected', metrics);
  };

  /**
   * Child `error` events are absorbed, never re-emitted: an unrecoverable
   * `tts_error` reaching `AgentSession` closes the session, and a child failing
   * is exactly what this adapter exists to survive. Recovery probes make that
   * fatal in practice — they keep re-failing for as long as a provider is down.
   * A listener is still attached so a child's `emit('error')`
   * never throws `ERR_UNHANDLED_ERROR`; logging is left to the attempt that
   * failed, which alone knows whether it was failing over or probing.
   *
   * What the adapter can't recover from still reaches the session, as this
   * adapter's own unrecoverable error: every instance failing. A failure after
   * audio went out can't be taken over by another instance without replaying
   * it, so it ends the utterance and reaches the session as an error that is
   * recoverable when another instance can serve the next utterance (see
   * `reportFailureAfterAudio`).
   */
  private readonly absorbChildError = () => {};

  private readonly fallbackForwarders: ((event: FallbackActivatedEvent) => void)[] = [];

  private setupEventForwarding(): void {
    this.ttsInstances.forEach((tts, i) => {
      const status = this._status[i]!;
      const forwardFallbackActivated = (event: FallbackActivatedEvent) => {
        // a probe's audio is discarded, so its notice must never reach the user, even while a user
        // attempt is serving on the same instance
        if (inRecoveryProbe.getStore()) return;
        if (status.serving > 0) {
          this.emit('fallback_activated', event);
        }
      };
      this.fallbackForwarders.push(forwardFallbackActivated);
      tts.on('metrics_collected', this.forwardMetrics);
      tts.on('error', this.absorbChildError);
      tts.on('fallback_activated', forwardFallbackActivated);
    });
  }

  /**
   * Returns the current status of all TTS instances, including availability and recovery state.
   */
  get status(): TTSStatus[] {
    return this._status;
  }

  getStreamingInstance(index: number): TTS {
    const tts = this.ttsInstances[index]!;
    if (tts.capabilities.streaming) {
      return tts;
    }
    // Wrap non-streaming TTS with StreamAdapter
    return new StreamAdapter(tts, new blingfire.SentenceTokenizer({ retainFormat: true }));
  }

  /**
   * Creates a new AudioResampler for the given TTS index if needed.
   * Returns null if the TTS sample rate matches the adapter's output rate.
   * Each stream should create its own resampler to avoid concurrency issues.
   * @internal
   */
  createResamplerForTTS(index: number): AudioResampler | null {
    const tts = this.ttsInstances[index]!;
    if (this.sampleRate !== tts.sampleRate) {
      this._logger.debug(
        `resampling ${tts.label} from ${tts.sampleRate}Hz to ${this.sampleRate}Hz`,
      );
      return new AudioResampler(tts.sampleRate, this.sampleRate, tts.numChannels);
    }
    return null;
  }

  private emitAvailabilityChanged(tts: TTS, available: boolean): void {
    const event: AvailabilityChangedEvent = { tts, available };
    // a listener that throws must not turn the request that caused the change into a failure
    try {
      this.emit('tts_availability_changed', event);
    } catch (error) {
      this._logger.error({ tts: tts.label, error }, 'tts_availability_changed listener failed');
    }
  }

  /**
   * Probes a failed instance in the background; the instance is available again once a probe
   * gets audio from it. Requests start probes, as in the Python adapter: one that skips an
   * unavailable instance, or fails over one, calls this. No timer probes an idle adapter.
   *
   * The probe is a short `stream()` request, so a TTS that only streams (`inference.TTS`
   * has no `synthesize()`) can recover. At most one probe runs per instance, and probes of
   * one instance start at least `recoveryDelayMs` apart, so a burst of requests during an outage
   * costs one probe per interval.
   * @internal
   */
  tryRecovery(index: number): void {
    if (this.closed) return;
    const status = this._status[index]!;
    if (status.recoveringTask && !status.recoveringTask.done) return;
    const now = performance.now();
    if (
      status.lastProbeStartedAt !== undefined &&
      now - status.lastProbeStartedAt < this.recoveryDelayMs
    ) {
      return;
    }
    status.lastProbeStartedAt = now;

    const tts = this.ttsInstances[index]!;
    status.recoveringTask = Task.from((controller) =>
      // everything the probe starts inherits the flag; see `inRecoveryProbe`
      inRecoveryProbe.run(true, async () => {
        let stream: SynthesizeStream | undefined;
        let streamingTts: TTS | undefined;
        let timedOut = false;
        const closeStream = () => stream?.close();
        const timeout = setTimeout(() => {
          timedOut = true;
          closeStream();
        }, RECOVERY_PROBE_TIMEOUT_MS);
        controller.signal.addEventListener('abort', closeStream, { once: true });
        try {
          streamingTts = this.getStreamingInstance(index);
          stream = streamingTts.stream({
            connOptions: {
              maxRetry: 0,
              timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
              retryIntervalMs: 1000,
            },
          });
          stream.pushText(RECOVERY_PROBE_TEXT);
          stream.endInput();
          let audioReceived = false;
          for await (const audio of stream) {
            if (audio !== SynthesizeStream.END_OF_STREAM) audioReceived = true;
          }
          if (controller.signal.aborted) return;
          // the timeout closed the stream: a probe that got some audio and then hung is no recovery
          if (timedOut) {
            throw new Error(`Recovery test did not finish within ${RECOVERY_PROBE_TIMEOUT_MS}ms`);
          }
          if (stream.error) {
            throw stream.error;
          }
          if (!audioReceived) {
            throw new Error('Recovery test completed but no audio was received');
          }

          // listeners must not inherit the probe flag, or a request they start loses its notices
          inRecoveryProbe.exit(() => this.markAvailable(index));
        } catch (error) {
          if (controller.signal.aborted) return;
          this._logger.debug({ tts: tts.label, error }, 'TTS recovery probe failed');
        } finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener('abort', closeStream);
          stream?.close();
          // a non-streaming instance gets a StreamAdapter for this probe only
          if (streamingTts && streamingTts !== tts) {
            await streamingTts.close();
          }
        }
      }),
    );
  }

  /**
   * Marks an instance unavailable, so requests skip it (and probe it, see `tryRecovery`), trying it
   * only as a last resort after the others failed. This only flags the instance: it starts no
   * recovery. The instance returns when a probe succeeds, or when it serves a request with audio
   * (see `markAvailable`). Emits `tts_availability_changed` if it was available.
   */
  markUnAvailable(index: number): void {
    const status = this._status[index]!;
    if (!status.available) return;
    status.available = false;
    this.emitAvailabilityChanged(this.ttsInstances[index]!, false);
  }

  /**
   * Marks an instance available again, after a probe succeeded or a request it served succeeded.
   * Serving counts because the probe a skip starts may not restore the instance: `recoveryDelayMs`
   * can rate-limit it, or it can lose the race to a request that serves the instance as a last
   * resort. A request served by the instance counts only if audio reached the caller, so a
   * request that made no provider call (blank input) or produced no frame proves nothing. Emits
   * `tts_availability_changed` if it was unavailable.
   * @internal
   */
  markAvailable(index: number): void {
    const status = this._status[index]!;
    if (status.available) return;
    status.available = true;
    const tts = this.ttsInstances[index]!;
    this._logger.info({ tts: tts.label }, 'TTS recovered');
    this.emitAvailabilityChanged(tts, true);
  }

  /** An instance failed: requests skip it from now on, and probe it in the background. */
  private markFailed(index: number): void {
    this.markUnAvailable(index);
    this.tryRecovery(index);
  }

  /**
   * An instance failed before any audio of the request went out: the request moves on to the
   * next one. Any error fails over, not only API errors: a plain error from a provider (a
   * plugin bug, a TTS without `synthesize()`) must not take the utterance down while another
   * instance can serve it. A non-API error is logged at error level, with its stack, since
   * it points at a bug rather than a provider outage.
   * @internal
   */
  failOver(index: number, error: unknown): void {
    const logged = { tts: this.ttsInstances[index]!.label, error: toError(error) };
    if (error instanceof APIError) {
      this._logger.warn(logged, 'TTS failed, switching to next instance');
    } else {
      this._logger.error(logged, 'TTS failed with an unexpected error, switching to next instance');
    }
    this.markFailed(index);
  }

  /**
   * An instance failed after its audio went out. Another instance can't take over without
   * replaying what the caller already heard, so the caller ends the utterance here. The
   * instance is marked unavailable and probed like any failed one, and the failure is reported as
   * a `tts_error`. It is recoverable when the adapter has another instance: the speech was cut
   * short, but the next utterance is served by another instance (every other one is tried as a
   * last resort), so `AgentSession` must not count it towards closing the session. With a single
   * instance nothing else can serve the next utterance, so the error is unrecoverable.
   * @internal
   */
  reportFailureAfterAudio(index: number, error: unknown): void {
    const tts = this.ttsInstances[index]!;
    const failure = toError(error);
    this._logger.warn(
      { tts: tts.label, error: failure },
      'TTS failed after audio pushed, ending the utterance without fallback',
    );
    this.markFailed(index);
    // an `error` emit with no listener throws; the warning above already told the logs
    if (this.listenerCount('error') === 0) return;
    try {
      this.emit('error', {
        type: 'tts_error',
        timestamp: Date.now(),
        label: this.label,
        error: failure,
        recoverable: this.ttsInstances.length > 1,
      });
    } catch (listenerError) {
      // a throwing listener must not stop the caller from ending the utterance
      this._logger.error({ error: toError(listenerError) }, 'TTS error listener failed');
    }
  }

  /**
   * Receives text and returns synthesis in the form of a {@link ChunkedStream}
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new FallbackChunkedStream(this, text, adapterConnOptions(connOptions), abortSignal);
  }

  /**
   * Returns a {@link SynthesizeStream} that can be used to push text and receive audio data
   *
   * @param options - Optional configuration including connection options
   */
  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new FallbackSynthesizeStream(this, adapterConnOptions(options?.connOptions));
  }

  /**
   * Close the FallbackAdapter and all underlying TTS instances.
   * This cancels any ongoing recovery probes, and none starts afterwards.
   */
  async close(): Promise<void> {
    // set before the sweep: a stream still in flight runs its failure handling after this, and
    // must not start a probe that nothing is left to cancel
    this.closed = true;

    // Cancel all recovery tasks
    const recoveryTasks = this._status
      .map((s) => s.recoveringTask)
      .filter((t): t is Task<void> => t !== null && !t.done);

    if (recoveryTasks.length > 0) {
      await cancelAndWait(recoveryTasks, 1000);
    }

    // Remove only our own listeners: the instances belong to the caller, who
    // may have subscribed to them directly.
    this.ttsInstances.forEach((tts, i) => {
      tts.off('metrics_collected', this.forwardMetrics);
      tts.off('error', this.absorbChildError);
      tts.off('fallback_activated', this.fallbackForwarders[i]!);
    });

    // Close all TTS instances
    await ThrowsPromise.all(this.ttsInstances.map((tts) => tts.close()));
  }

  override get _wrappedTts(): readonly TTS[] {
    return this.ttsInstances;
  }

  /** Every provider gets its release attempt; one failure surfaces after the others ran. */
  override async releaseIdleConnections(): Promise<void> {
    const results = await Promise.allSettled(
      this.ttsInstances.map((tts) => tts.releaseIdleConnections()),
    );
    const failure = results.find((r) => r.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

/**
 * The instances a request tries, in order: every one in priority order, then, as a last resort,
 * the ones it skipped as unavailable (`skipped`, filled by the caller while it iterates). A request
 * fails only after this runs out, so it never fails while an instance remains untried.
 */
function* attemptOrder(count: number, skipped: readonly number[]): Generator<number> {
  for (let i = 0; i < count; i++) yield i;
  if (skipped.length > 0) {
    log().warn(
      'Every available TTS instance failed, trying the ones marked unavailable as a last resort',
    );
    yield* skipped;
  }
}

/** The instance that served: its label, position, model and provider. */
function fallbackAttrs(tts: TTS, index: number): Attributes {
  const attrs: Attributes = {
    [traceTypes.ATTR_FALLBACK_LABEL]: tts.label,
    [traceTypes.ATTR_FALLBACK_INDEX]: index,
    [traceTypes.ATTR_GEN_AI_REQUEST_MODEL]: tts.model,
  };
  const normalized = traceTypes.genAIProviderName(tts.provider);
  if (normalized !== undefined) {
    attrs[traceTypes.ATTR_GEN_AI_PROVIDER_NAME] = normalized;
  }
  return attrs;
}

/**
 * The instance that served: on the current (attempt) span, and as the response side of `spans`
 * (the adapter's request span and the caller's, tts_node). From `tts`, not the adapter:
 * concurrent requests may be served by different instances.
 */
function recordFallbackServed(tts: TTS, index: number, ...spans: (Span | undefined)[]): void {
  const attrs = fallbackAttrs(tts, index);
  trace.getActiveSpan()?.setAttributes(attrs);
  const responseAttrs: Attributes = { [traceTypes.ATTR_GEN_AI_RESPONSE_MODEL]: tts.model };
  const provider = attrs[traceTypes.ATTR_GEN_AI_PROVIDER_NAME];
  if (provider !== undefined) {
    responseAttrs[traceTypes.ATTR_GEN_AI_PROVIDER_NAME] = provider;
  }
  for (const span of spans) {
    span?.setAttributes(responseAttrs);
  }
}

class FallbackChunkedStream extends ChunkedStream {
  protected override emitMetrics = false;
  private adapter: FallbackAdapter;
  private connOptions: APIConnectOptions;
  private _logger = log();
  // the span this request was made under (tts_node); see recordFallbackServed
  private callerSpan: Span | undefined = trace.getActiveSpan();
  /** The instance whose audio reached the caller (see recordFallbackServed). */
  private servedTts?: TTS;

  label: string = 'tts.FallbackChunkedStream';

  protected override get responseModel(): string {
    return this.servedTts?.model ?? this.adapter.model;
  }

  protected override get responseProvider(): string {
    return this.servedTts?.provider ?? this.adapter.provider;
  }

  constructor(
    adapter: FallbackAdapter,
    text: string,
    connOptions: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, adapter, connOptions, abortSignal);
    this.adapter = adapter;
    this.connOptions = connOptions;
    if (abortSignal?.aborted) this.close();
  }

  /**
   * @throws {APIConnectionError} When all TTS providers have been exhausted
   */
  protected async run(): Promise<Throws<void, APIConnectionError>> {
    if (this.abortSignal.aborted || this.inputText.trim().length === 0) return;

    let lastRequestId: string = '';
    let lastSegmentId: string = '';
    // instances skipped as unavailable: tried again, as a last resort, after the others failed
    const skipped: number[] = [];
    for (const i of attemptOrder(this.adapter.ttsInstances.length, skipped)) {
      if (this.abortSignal.aborted) return;
      const tts = this.adapter.ttsInstances[i]!;
      const status = this.adapter.status[i]!;
      if (!status.available && !skipped.includes(i)) {
        this.adapter.tryRecovery(i);
        skipped.push(i);
        continue;
      }
      const resampler = this.adapter.createResamplerForTTS(i);
      // why the stream failed, if its provider reported it
      let providerError: Error | undefined;
      // Tracks whether the inner stream yielded any real audio frames.
      // A phantom `AudioResampler.flush()` frame (observed on rtc-node
      // 0.13.25) could otherwise mask a silent failure as a success.
      let sawRawAudio = false;
      let audioPushed = false;
      let closeStream: () => void = () => {};

      status.serving++;
      try {
        this._logger.debug({ tts: tts.label }, 'attempting TTS synthesis');
        const connOptions: APIConnectOptions = {
          ...this.connOptions,
          maxRetry: this.adapter.maxRetryPerTTS,
        };
        const stream = tts.synthesize(this.inputText, connOptions, this.abortSignal);
        closeStream = () => stream.close();
        this.abortSignal.addEventListener('abort', closeStream, { once: true });
        if (this.abortSignal.aborted) return;
        for await (const audio of stream) {
          if (this.abortController.signal.aborted) {
            stream.close();
            return;
          }

          sawRawAudio = true;

          if (resampler) {
            for (const frame of resampler.push(audio.frame)) {
              this.queue.put({
                ...audio,
                frame,
              });
              audioPushed = true;
            }
          } else {
            this.queue.put(audio);
            audioPushed = true;
          }
          lastRequestId = audio.requestId;
          lastSegmentId = audio.segmentId;
        }

        if (this.abortSignal.aborted) return;

        // A provider that failed before anything reached the caller fails over without a flush:
        // the flush would push the resampler's tail, the caller would hear a fragment, and the
        // utterance would end here instead of on the next instance.
        if (stream.error && !audioPushed) {
          providerError = stream.error;
          throw new APIConnectionError({
            message: sawRawAudio
              ? 'TTS synthesis failed before any audio was delivered'
              : 'TTS synthesis completed but no audio was received',
          });
        }

        // Only flush the resampler if real audio actually went in — otherwise
        // flush() can return phantom frames that would mask a silent failure
        // from the primary provider. When audio was already delivered the flush comes first, so
        // what the caller heard stays whole.
        if (resampler && sawRawAudio) {
          for (const frame of resampler.flush()) {
            this.queue.put({
              requestId: lastRequestId || '',
              segmentId: lastSegmentId || '',
              frame,
              final: true,
            });
            audioPushed = true;
          }
        }

        // Silent failures must trigger fallback.
        if (!sawRawAudio) {
          providerError = stream.error;
          throw new APIConnectionError({
            message: 'TTS synthesis completed but no audio was received',
          });
        }

        // Audio already went out: handled in the catch below as a failure after audio.
        if (stream.error) {
          providerError = stream.error;
          throw new APIConnectionError({
            message: 'TTS synthesis failed after audio was received',
          });
        }

        this._logger.debug({ tts: tts.label }, 'TTS synthesis succeeded');
        this.servedTts = tts;
        recordFallbackServed(tts, i, this.ttsRequestSpan, this.callerSpan);
        // served means audio reached the caller
        if (audioPushed) this.adapter.markAvailable(i);
        return;
      } catch (error) {
        if (this.abortSignal.aborted) return;
        // what reached the caller decides: a provider that failed before the resampler produced
        // a frame has played nothing, so another instance can still serve the whole utterance
        if (audioPushed) {
          // the caller heard this instance's audio: it served, partially
          this.servedTts = tts;
          recordFallbackServed(tts, i, this.ttsRequestSpan, this.callerSpan);
          this.adapter.reportFailureAfterAudio(i, providerError ?? error);
          return;
        }
        this.adapter.failOver(i, providerError ?? error);
      } finally {
        if (this.abortSignal.aborted && audioPushed) {
          this.servedTts = tts;
          recordFallbackServed(tts, i, this.ttsRequestSpan, this.callerSpan);
        }
        this.abortSignal.removeEventListener('abort', closeStream);
        closeStream();
        status.serving--;
        resampler?.close();
      }
    }
    if (this.abortSignal.aborted) return;
    const labels = this.adapter.ttsInstances.map((t) => t.label).join(', ');
    throw new APIConnectionError({
      message: `all TTS instances failed (${labels})`,
    });
  }
}

class FallbackSynthesizeStream extends SynthesizeStream {
  protected override emitMetrics = false;
  private adapter: FallbackAdapter;
  private tokenBuffer: (
    | string
    | typeof SynthesizeStream.FLUSH_SENTINEL
    | typeof SynthesizeStream.END_OF_STREAM
  )[] = [];
  private audioPushed = false;
  private _logger = log();
  // the span this request was made under (tts_node); see recordFallbackServed
  private callerSpan: Span | undefined = trace.getActiveSpan();
  /** The instance whose audio reached the caller (see recordFallbackServed). */
  private servedTts?: TTS;

  label: string = 'tts.FallbackSynthesizeStream';

  protected override get responseModel(): string {
    return this.servedTts?.model ?? this.adapter.model;
  }

  protected override get responseProvider(): string {
    return this.servedTts?.provider ?? this.adapter.provider;
  }

  constructor(adapter: FallbackAdapter, connOptions: APIConnectOptions) {
    super(adapter, connOptions);
    this.adapter = adapter;
  }

  /**
   * @throws {APIConnectionError} When all TTS providers have been exhausted
   */
  protected async run(): Promise<Throws<void, APIConnectionError>> {
    if (this.abortSignal.aborted) return;
    let textReceived = false;
    let inputEnded = false;
    const readInputLLMStream = (async () => {
      try {
        for await (const input of this.input) {
          if (this.abortController.signal.aborted) break;
          this.tokenBuffer.push(input);
          if (typeof input === 'string' && input.trim().length > 0) textReceived = true;
        }
      } catch (error) {
        this._logger.debug({ error }, 'Error reading input LLM stream');
        throw error;
      } finally {
        this.tokenBuffer.push(SynthesizeStream.END_OF_STREAM);
        inputEnded = true;
      }
    })();

    // instances skipped as unavailable: tried again, as a last resort, after the others failed
    const skipped: number[] = [];
    for (const i of attemptOrder(this.adapter.ttsInstances.length, skipped)) {
      if (this.abortSignal.aborted) return;
      const originalTts = this.adapter.ttsInstances[i]!;
      const status = this.adapter.status[i]!;
      let lastRequestId: string = '';
      let lastSegmentId: string = '';

      if (!status.available && !skipped.includes(i)) {
        this.adapter.tryRecovery(i);
        skipped.push(i);
        continue;
      }
      const tts = this.adapter.getStreamingInstance(i);
      let stream!: SynthesizeStream;
      let resampler: AudioResampler | null = null;
      const closeStream = () => stream?.close();
      this.abortSignal.addEventListener('abort', closeStream, { once: true });
      // why the stream failed, if its provider reported it
      let providerError: Error | undefined;

      // ttfb measures the fallback adapter as a whole: anchor on the first
      // time a sentence was handed to any underlying TTS — even one that
      // failed before emitting audio — and never overwrite it when falling
      // back to another TTS (markStarted only takes effect once).
      let captureStartedTime: () => void = () => {};

      status.serving++;
      try {
        resampler = this.adapter.createResamplerForTTS(i);
        this._logger.debug({ tts: originalTts.label }, 'attempting TTS stream');

        const connOptions: APIConnectOptions = {
          ...this.connOptions,
          maxRetry: this.adapter.maxRetryPerTTS,
        };

        stream = tts.stream({ connOptions });
        if (this.abortSignal.aborted) return;
        let bufferIndex = 0;
        let streamOutputCompleted = false;

        captureStartedTime = () => {
          const startedTime = stream.startedTime;
          if (startedTime !== undefined) {
            this.markStarted(startedTime);
          }
        };
        const forwardBufferToTTS = async () => {
          while (true) {
            while (bufferIndex < this.tokenBuffer.length) {
              const token = this.tokenBuffer[bufferIndex++]!;
              if (token === SynthesizeStream.FLUSH_SENTINEL) {
                stream.flush();
              } else if (token === SynthesizeStream.END_OF_STREAM) {
                stream.endInput();
                return;
              } else {
                stream.pushText(token);
              }
            }
            await new ThrowsPromise<void, never>((resolve) => setTimeout(resolve, FORWARD_POLL_MS));
            if (this.abortController.signal.aborted || streamOutputCompleted) {
              stream.endInput();
              return;
            }
          }
        };

        // Tracks whether the inner stream yielded any real audio frames.
        // `audioPushed` can be flipped on by a phantom `AudioResampler.flush()`
        // frame even when nothing was pushed in (rtc-node 0.13.25), so we
        // cannot use it to detect silent failures.
        let sawRawAudio = false;
        const processOutput = async () => {
          try {
            for await (const audio of stream) {
              if (this.abortController.signal.aborted) {
                stream.close();
                return;
              }

              if (audio === SynthesizeStream.END_OF_STREAM) {
                // Don't forward END_OF_STREAM yet — only emit after we verify audio
                // was received. Otherwise a silent failure would signal completion
                // to consumers before fallback can try the next TTS.
                continue;
              }

              sawRawAudio = true;
              captureStartedTime();

              if (resampler) {
                for (const frame of resampler.push(audio.frame)) {
                  this.queue.put({
                    ...audio,
                    frame,
                  });
                  this.audioPushed = true;
                }
              } else {
                this.queue.put(audio);
                this.audioPushed = true;
              }
              lastRequestId = audio.requestId;
              lastSegmentId = audio.segmentId;
            }

            if (this.abortSignal.aborted) return;

            // A provider that failed before anything reached the caller must fail over, so its
            // resampler is not flushed: the flush would push a fragment and end the utterance.
            const failedBeforeAudio = !!stream.error && !this.audioPushed;

            // Only flush the resampler if real audio actually went in —
            // otherwise flush() can return phantom frames that would mask a
            // silent failure from the primary provider.
            if (resampler && sawRawAudio && !failedBeforeAudio) {
              for (const frame of resampler.flush()) {
                this.queue.put({
                  requestId: lastRequestId || '',
                  segmentId: lastSegmentId || '',
                  frame,
                  final: true,
                });
                this.audioPushed = true;
              }
            }
          } finally {
            // processOutput and forwardBufferToTTS run in parallel.
            // forwardBufferToTTS polls tokenBuffer and only exits when it sees END_OF_STREAM.
            // But END_OF_STREAM is only added when the LLM finishes streaming (line 417).
            // If the TTS fails while the LLM is still streaming, forwardBufferToTTS would
            // keep polling indefinitely, blocking fallback to the next TTS.
            // This flag tells it to exit early.
            streamOutputCompleted = true;
          }
        };
        const [outputResult, forwardBufferResult] = await ThrowsPromise.allSettled([
          processOutput(),
          forwardBufferToTTS().catch((err) => {
            stream.close(); // Close stream so processOutput can exit
            throw err;
          }),
        ]);
        if (this.abortSignal.aborted) {
          if (this.audioPushed) {
            this.servedTts = originalTts;
            recordFallbackServed(originalTts, i, this.ttsRequestSpan, this.callerSpan);
          }
          return;
        }
        if (outputResult.status === 'rejected') {
          stream.close();
          throw outputResult.reason;
        }
        if (forwardBufferResult.status === 'rejected') {
          stream.close();
          throw forwardBufferResult.reason;
        }

        // Silent failures must trigger fallback. See `sawRawAudio` above for
        // why we don't check `audioPushed` here.
        if (!sawRawAudio) {
          providerError = stream.error;
          // Do not wait for EOF here: a failed provider must fall back while text is arriving.
          if (inputEnded && !textReceived && !providerError) {
            this.queue.put(SynthesizeStream.END_OF_STREAM);
            await readInputLLMStream;
            return;
          }
          throw new APIConnectionError({
            message: 'TTS stream completed but no audio was received',
          });
        }

        // Audio already went out: handled in the catch below as a failure after audio.
        if (stream.error) {
          providerError = stream.error;
          throw new APIConnectionError({
            message: 'TTS stream failed after audio was received',
          });
        }

        this.queue.put(SynthesizeStream.END_OF_STREAM);
        this._logger.debug({ tts: originalTts.label }, 'TTS stream succeeded');
        this.servedTts = originalTts;
        recordFallbackServed(originalTts, i, this.ttsRequestSpan, this.callerSpan);
        // served means audio reached the caller: an earlier instance's audio would have ended the
        // request, so `audioPushed` here is this instance's
        if (this.audioPushed) this.adapter.markAvailable(i);
        await readInputLLMStream.catch(() => {});
        return;
      } catch (error) {
        if (this.abortSignal.aborted) return;
        if (this.audioPushed) {
          // the caller heard this instance's audio: it served, partially
          this.servedTts = originalTts;
          recordFallbackServed(originalTts, i, this.ttsRequestSpan, this.callerSpan);
          this.adapter.reportFailureAfterAudio(i, providerError ?? error);
          // end the utterance: the rest of the text is dropped, not replayed on another instance
          this.queue.put(SynthesizeStream.END_OF_STREAM);
          void readInputLLMStream.catch(() => {});
          return;
        }
        this.adapter.failOver(i, providerError ?? error);
      } finally {
        status.serving--;
        // the stream may have received text and failed before emitting audio;
        // its started time must still anchor the fallback's ttfb
        captureStartedTime();
        this.abortSignal.removeEventListener('abort', closeStream);
        stream?.close();
        resampler?.close();
        // a non-streaming instance gets a StreamAdapter for this attempt only
        if (tts !== originalTts) {
          await tts.close();
        }
      }
    }
    await readInputLLMStream.catch(() => {});
    if (this.abortSignal.aborted) return;
    const labels = this.adapter.ttsInstances.map((t) => t.label).join(', ');
    throw new APIConnectionError({
      message: `all TTS instances failed (${labels})`,
    });
  }
}
