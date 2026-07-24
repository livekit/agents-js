// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import { AudioFrame, type ParticipantKind } from '@livekit/rtc-node';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import {
  type Context,
  ROOT_CONTEXT,
  type Span,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import type { ReadableStream, WritableStreamDefaultWriter } from 'node:stream/web';
import { TransformStream } from 'node:stream/web';
import { isAPIError } from '../_exceptions.js';
import {
  BaseStreamingTurnDetector,
  BaseStreamingTurnDetectorStream,
  MIN_SILENCE_DURATION_MS,
  type TurnDetectionEvent,
} from '../inference/eot/base.js';
import { apiConnectDefaults, intervalForRetry } from '../inference/interruption/defaults.js';
import { InterruptionDetectionError } from '../inference/interruption/errors.js';
import type { AdaptiveInterruptionDetector } from '../inference/interruption/interruption_detector.js';
import { InterruptionStreamSentinel } from '../inference/interruption/interruption_stream.js';
import {
  type InterruptionSentinel,
  type OverlappingSpeechEvent,
} from '../inference/interruption/types.js';
import type { LanguageCode } from '../language.js';
import { ChatContext } from '../llm/chat_context.js';
import { log } from '../log.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import { mergeReadableStreams } from '../stream/merge_readable_streams.js';
import { type StreamChannel, createStreamChannel } from '../stream/stream_channel.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { traceTypes, tracer } from '../telemetry/index.js';
import { splitWords } from '../tokenize/basic/word.js';
import type { Future } from '../utils.js';
import { Task, cancelAndWait, delay, readStream, waitForAbort } from '../utils.js';
import { type VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import type { TurnDetectionMode } from './agent_session.js';
import {
  type EotPredictionEvent,
  type UserTurnExceededEvent,
  type _AgentBackchannelOpportunityEvent,
  _createAgentBackchannelOpportunityEvent,
  createEotPredictionEvent,
  createUserTurnExceededEvent,
} from './events.js';
import type { STTNode } from './io.js';
import { toSnakeCaseDeep } from './report.js';
import {
  type BaseEndpointing,
  createEndpointing,
  defaultEndpointingOptions,
} from './turn_config/endpointing.js';
import type { UserTurnLimitOptions } from './turn_config/user_turn_limit.js';
import {
  createSilenceFrame,
  createSilenceFrameLike,
  setParticipantSpanAttributes,
} from './utils.js';

// Maximum number of chat items included in the `lk.chat_ctx` attribute of the
// `eou_detection` span (mirrors Python's `_EOU_MAX_HISTORY_TURNS`).
const EOU_MAX_HISTORY_TURNS = 6;

export interface EndOfTurnInfo {
  /** The new transcript text from the user's speech. */
  newTranscript: string;
  /** Confidence score of the transcript (0-1). */
  transcriptConfidence: number;
  /** Delay from speech stop to final transcription in milliseconds. */
  transcriptionDelay: number | undefined;
  /** Delay from speech stop to end of utterance detection in milliseconds. */
  endOfUtteranceDelay: number | undefined;
  /** Timestamp when user started speaking (milliseconds since epoch). */
  startedSpeakingAt: number | undefined;
  /** Timestamp when user stopped speaking (milliseconds since epoch). */
  stoppedSpeakingAt: number | undefined;
  /**
   * When `true`, the agent activity commits the user turn to chat context but
   * skips generating the normal auto-reply. Mirrors python `_EndOfTurnInfo.skip_reply`.
   * Set, for example, when AMD has taken over the turn with a machine verdict and the
   * caller drives its own `generateReply` (e.g. leaving a voicemail).
   */
  skipReply?: boolean;
  /** The turn's speech overlapped agent speech and was classified a backchannel. */
  backchannelOverAgent?: boolean;
}

type EndOfTurnMetrics = {
  startedSpeakingAt: number | undefined;
  stoppedSpeakingAt: number | undefined;
  transcriptionDelay: number | undefined;
  endOfUtteranceDelay: number | undefined;
};

function computeEndOfTurnMetrics({
  speechStartTime,
  lastSpeakingTime,
  lastFinalTranscriptTime,
  now,
}: {
  speechStartTime: number | undefined;
  lastSpeakingTime: number | undefined;
  lastFinalTranscriptTime: number;
  now: number;
}): EndOfTurnMetrics {
  if (
    lastFinalTranscriptTime === 0 ||
    lastSpeakingTime === undefined ||
    speechStartTime === undefined ||
    lastSpeakingTime < speechStartTime
  ) {
    return {
      startedSpeakingAt: undefined,
      stoppedSpeakingAt: undefined,
      transcriptionDelay: undefined,
      endOfUtteranceDelay: undefined,
    };
  }

  return {
    startedSpeakingAt: speechStartTime,
    stoppedSpeakingAt: lastSpeakingTime,
    transcriptionDelay: Math.max(lastFinalTranscriptTime - lastSpeakingTime, 0),
    endOfUtteranceDelay: Math.max(now - lastSpeakingTime, 0),
  };
}

export interface PreemptiveGenerationInfo {
  newTranscript: string;
  transcriptConfidence: number;
  /** Timestamp when user started speaking (milliseconds since epoch), if known. */
  startedSpeakingAt: number | undefined;
}

export interface RecognitionHooks {
  onInterruption: (ev: OverlappingSpeechEvent) => void;
  onBackchannelConfirmed: () => void;
  onStartOfSpeech: (ev: VADEvent) => void;
  onVADInferenceDone: (ev: VADEvent) => void;
  onEndOfSpeech: (ev: VADEvent) => void;
  onInterimTranscript: (ev: SpeechEvent, speaking: boolean | undefined) => void;
  onFinalTranscript: (ev: SpeechEvent, speaking: boolean | undefined) => void;
  onEndOfTurn: (info: EndOfTurnInfo) => Promise<boolean>;
  onEotPrediction: (ev: EotPredictionEvent) => void;
  onAgentBackchannelOpportunity: (ev: _AgentBackchannelOpportunityEvent) => void;
  onPreemptiveGeneration: (info: PreemptiveGenerationInfo) => void;
  onUserTurnExceeded: (ev: UserTurnExceededEvent) => void;

  retrieveChatCtx: () => ChatContext;
}

interface UserTurnTracker {
  words: number;
  transcript: string;
  startedAt?: number;
}

export class STTPipeline {
  static readonly PUMP_TASK_CANCEL_TIMEOUT = 5000;

  private sttNode: STTNode;
  private _audioChannel: StreamChannel<AudioFrame> = createStreamChannel();
  private _eventChannel: StreamChannel<SpeechEvent> = createStreamChannel();
  private _pumpTask: Task<void>;
  /** Wall-clock anchor for this stream, used with STT-relative timestamps. */
  inputStartedAt?: number;

  constructor(sttNode: STTNode) {
    this.sttNode = sttNode;
    this._pumpTask = Task.from(({ signal }) => this.sttPump(signal));
    this._pumpTask.addDoneCallback(() => this._eventChannel.close());
  }

  get audioChannel() {
    return this._audioChannel;
  }

  get eventChannel() {
    return this._eventChannel;
  }

  private async sttPump(signal: AbortSignal): Promise<void> {
    const node = await this.sttNode(this._audioChannel.stream(), {});
    if (node === null) return;

    try {
      for await (const value of readStream(node, signal)) {
        if (typeof value === 'string') {
          throw new Error(`STT node must yield SpeechEvent, got: ${typeof value}`);
        }
        await this._eventChannel.write(value);
      }
    } finally {
      await node.cancel().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await cancelAndWait([this._pumpTask], STTPipeline.PUMP_TASK_CANCEL_TIMEOUT);
  }
}

export interface _TurnDetector {
  /** The model name used by this turn detector. */
  readonly model: string;
  /** The provider name for this turn detector. */
  readonly provider: string;
  unlikelyThreshold: (language?: LanguageCode) => Promise<number | undefined>;
  supportsLanguage: (language?: LanguageCode) => Promise<boolean>;
  /**
   * Text-based detectors own their inference timeout behavior internally.
   */
  predictEndOfTurn(chatCtx: ChatContext, timeoutMs?: number): Promise<number>;
}

export interface AudioRecognitionOptions {
  /** Hooks for recognition events. */
  recognitionHooks: RecognitionHooks;
  /** Speech-to-text node. */
  stt?: STTNode;
  /** Voice activity detection. */
  vad?: VAD;
  /**
   * True iff the wired VAD was auto-provisioned by `AgentSession` rather than
   * supplied by the caller. Read at every "is VAD configured?" call site so
   * a framework-default VAD behaves like no VAD for downstream eligibility
   * decisions (e.g. STT-hook `speaking=` payload).
   */
  usingDefaultVad?: boolean;
  /** Turn detector for end-of-turn prediction. Accepts text-based detectors
   * via `_TurnDetector` (e.g. plugins/livekit) or audio-based detectors via
   * `TurnDetector` (e.g. `inference.TurnDetector`). */
  turnDetector?: _TurnDetector | BaseStreamingTurnDetector;
  /** Turn detection mode. */
  turnDetectionMode?: TurnDetectionMode;
  interruptionDetection?: AdaptiveInterruptionDetector;
  /**
   * Backchannel boundary for adaptive interruption suppression, expressed in milliseconds.
   *
   * A single number applies to both the start and end of agent speech; a `[start, end]` tuple
   * configures them separately. `null` (or `undefined`) disables.
   */
  backchannelBoundary?: number | [number, number] | null;
  /** Endpointing delay strategy. */
  endpointing?: BaseEndpointing;
  /** User turn limit configuration. */
  userTurnLimit?: UserTurnLimitOptions;
  /** @deprecated Use endpointing instead. */
  minEndpointingDelay?: number;
  /** @deprecated Use endpointing instead. */
  maxEndpointingDelay?: number;
  /** Root span context for tracing. */
  rootSpanContext?: Context;
  /** STT model name for tracing */
  sttModel?: string;
  /** STT provider name for tracing */
  sttProvider?: string;
  /** Getter for linked participant for span attribution */
  getLinkedParticipant?: () => ParticipantLike | undefined;
  /** Predicate used to substitute silence for STT while still forwarding real audio elsewhere. */
  shouldDiscardAudioForStt?: (frame: AudioFrame) => boolean;
}

/**
 * Minimal participant shape for span attribution.
 * Compatible with both `LocalParticipant` and `RemoteParticipant` from `@livekit/rtc-node`.
 */
export interface ParticipantLike {
  sid: string | undefined;
  identity: string;
  kind: ParticipantKind;
}

// TODO add ability to update stt/vad/interruption-detection
export class AudioRecognition {
  private hooks: RecognitionHooks;
  private stt?: STTNode;
  private sttPipeline?: STTPipeline;
  private vad?: VAD;
  private usingDefaultVad: boolean;
  private turnDetector?: _TurnDetector | BaseStreamingTurnDetector;
  private turnDetectorStream?: BaseStreamingTurnDetectorStream;
  /**
   * Future for the in-flight audio-EOT inference request. Recognition owns the
   * request lifecycle: it starts a request on the VAD silence tick, holds the
   * future here, awaits it (with the model prediction timeout) in the eou bounce, and
   * clears it on turn boundaries / superseding speech.
   */
  private turnDetectorPredictionFut?: Future<TurnDetectionEvent>;
  /**
   * True between a turn flush (commit / clearUserTurn) and the next VAD
   * start-of-speech. While set, a late stt final won't start a fresh request;
   * the eou bounce short-circuits via `onMissingEotPrediction`.
   */
  private turnDetectorFlushed = false;
  /** Warn once per recognition when the eou bounce runs after a flush. */
  private turnDetectorLatePredictionWarned = false;
  /**
   * The last `TurnDetectionEvent` we forwarded via `onEotPrediction`, kept
   * by reference to dedupe: both EOU triggers in a turn read the same
   * resolved prediction future, but the event should fire once per request.
   */
  private lastEmittedEotPrediction?: TurnDetectionEvent;
  private warnedTurnDetectorPushFailure = false;
  private turnDetectionMode?: TurnDetectionMode;
  private endpointing: BaseEndpointing;
  private userTurnLimit?: UserTurnLimitOptions;
  private lastLanguage?: LanguageCode;
  private rootSpanContext?: Context;
  private sttModel?: string;
  private sttProvider?: string;
  private getLinkedParticipant?: () => ParticipantLike | undefined;

  private deferredInputStream: DeferredReadableStream<AudioFrame>;
  private logger = log();
  private lastFinalTranscriptTime = 0;
  private audioTranscript = '';
  private audioInterimTranscript = '';
  private audioPreflightTranscript = '';
  private finalTranscriptConfidence: number[] = [];
  private lastSpeakingTime: number | undefined;
  private speechStartTime: number | undefined;
  private userTurnStart: number | undefined;
  private userTurnCommitted = false;
  private speaking = false;
  private vadSpeechStarted = false;
  private sampleRate?: number;

  private userTurnSpan?: Span;
  private userTurnTracker: UserTurnTracker = { words: 0, transcript: '' };
  // Provider-known STT ids for the current user turn. Written to the
  // `user_turn` span when it ends so we can correlate traces with the
  // provider's logs for debugging.
  private sttRequestIds: string[] = [];

  private vadInputStream: ReadableStream<AudioFrame>;
  private sttInputStream: ReadableStream<AudioFrame>;
  /**
   * Active subscriber writers fed from {@link subscribersBroadcast}. Each
   * {@link subscribeAudioStream} call appends one entry; entries are dropped
   * (and their stream closed) on {@link close}.
   *
   * The broadcast pattern replaces an earlier `tee()`-based approach where
   * the second branch grew without bound for sessions that never called
   * `subscribeAudioStream()` (every voice session that doesn't use AMD).
   * With this design no extra buffering happens until at least one
   * subscriber is registered.
   */
  private subscriberWriters: WritableStreamDefaultWriter<AudioFrame>[] = [];
  private silenceAudioTransform = new IdentityTransform<AudioFrame>();
  private silenceAudioWriter: WritableStreamDefaultWriter<AudioFrame>;
  private sttOwnershipTransferred = false;
  private readonly sttLifecycleLock = new Mutex();

  // all cancellable tasks
  private bounceEOUTask?: Task<void>;
  private commitUserTurnTask?: Task<void>;
  private sttForwardTask?: Task<void>;
  private vadTask?: Task<void>;
  private vadStream?: VADStream;
  private sttConsumerTask?: Task<void>;
  private interruptionTask?: Task<void>;

  // interruption detection
  private interruptionDetection?: AdaptiveInterruptionDetector;
  private ignoreUserTranscriptUntil?: number;
  private transcriptBuffer: SpeechEvent[];
  private isInterruptionEnabled: boolean;
  private isAgentSpeaking: boolean;
  private agentSpeechStartedAt?: number;
  private interruptionDetected?: boolean;
  private overlapInCurrentTurn = false;
  private turnBackchannelOverAgent = false;
  private interruptionStreamChannel?: StreamChannel<InterruptionSentinel | AudioFrame>;
  private closed = false;

  // backchannel boundary for adaptive interruption suppression
  private backchannelBoundary?: [number, number];
  private backchannelBoundaryTimer?: ReturnType<typeof setTimeout>;
  /** Callback invoked when the backchannel boundary timer expires naturally. */
  backchannelBoundaryCallback?: () => void;

  constructor(opts: AudioRecognitionOptions) {
    this.hooks = opts.recognitionHooks;
    this.stt = opts.stt;
    this.vad = opts.vad;
    this.usingDefaultVad = opts.usingDefaultVad ?? false;
    this.turnDetector = opts.turnDetector;
    this.checkVadSilenceRequirement();
    // The FSM stream is opened on `start()` so callers can hand off the
    // previous activity's stream (cloud↔local fallback state, in-flight
    // inference) instead of forcing a cold restart.
    this.turnDetectionMode = opts.turnDetectionMode;
    this.userTurnLimit = opts.userTurnLimit;
    this.endpointing =
      opts.endpointing ??
      createEndpointing({
        ...defaultEndpointingOptions,
        minDelay: opts.minEndpointingDelay ?? defaultEndpointingOptions.minDelay,
        maxDelay: opts.maxEndpointingDelay ?? defaultEndpointingOptions.maxDelay,
      });
    this.lastLanguage = undefined;
    this.rootSpanContext = opts.rootSpanContext;
    this.sttModel = opts.sttModel;
    this.sttProvider = opts.sttProvider;
    this.getLinkedParticipant = opts.getLinkedParticipant;

    this.deferredInputStream = new DeferredReadableStream<AudioFrame>();
    this.interruptionDetection = opts.interruptionDetection;
    this.transcriptBuffer = [];
    this.isInterruptionEnabled = !!(opts.interruptionDetection && opts.vad);
    this.isAgentSpeaking = false;
    this.interruptionDetected = undefined;

    const rawBoundary = opts.backchannelBoundary;
    if (rawBoundary === undefined || rawBoundary === null) {
      this.backchannelBoundary = undefined;
    } else if (typeof rawBoundary === 'number') {
      if (rawBoundary < 0) {
        throw new Error('backchannelBoundary must be a non-negative number');
      }
      this.backchannelBoundary = [rawBoundary, rawBoundary];
    } else {
      const [start, end] = rawBoundary;
      if (rawBoundary.length !== 2 || start < 0 || end < 0) {
        throw new Error('backchannelBoundary must be a tuple of two non-negative numbers');
      }
      this.backchannelBoundary = [start, end];
    }

    // Pipe the deferred input stream through a broadcast transform. The
    // transform is a no-op identity until something calls `subscribeAudioStream()`
    // — at which point each frame is forwarded to the registered subscriber
    // writers in addition to flowing downstream to VAD/STT. This avoids the
    // unbounded queue growth of a pre-emptive `tee()` for sessions that
    // never subscribe (i.e. anything not using AMD).
    const broadcast = new TransformStream<AudioFrame, AudioFrame>(
      {
        transform: (chunk, controller) => {
          controller.enqueue(chunk);
          // Fan the same frame into the audio EOT detector stream when
          // one is attached. The FSM accepts arbitrary-rate input and
          // resamples internally. `pushAudio` is a no-op when the stream's
          // internal channel is closed; any actual throw indicates a bug
          // (e.g. resampler init failure, sample-rate mismatch). Log once
          // when we hit that path so a regression doesn't silently drop
          // every audio frame.
          if (this.turnDetectorStream !== undefined) {
            try {
              this.turnDetectorStream.pushAudio(chunk);
            } catch (err) {
              if (!this.warnedTurnDetectorPushFailure) {
                this.warnedTurnDetectorPushFailure = true;
                this.logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  'audio EOT stream pushAudio failed; dropping frames for this turn',
                );
              }
            }
          }
          if (this.subscriberWriters.length === 0) return;
          for (const writer of this.subscriberWriters) {
            writer.write(chunk).catch(() => {
              // Subscriber stream closed or backpressure exceeded; drop.
            });
          }
        },
      },
      { highWaterMark: Number.MAX_SAFE_INTEGER },
      { highWaterMark: Number.MAX_SAFE_INTEGER },
    );
    const primaryInputStream = this.deferredInputStream.stream.pipeThrough(broadcast);

    const replaceSttInputWithSilence = (stream: ReadableStream<AudioFrame>) => {
      if (!opts.shouldDiscardAudioForStt) {
        return stream;
      }

      return stream.pipeThrough(
        new TransformStream<AudioFrame, AudioFrame>({
          transform: (frame, controller) => {
            controller.enqueue(
              opts.shouldDiscardAudioForStt!(frame) ? createSilenceFrameLike(frame) : frame,
            );
          },
        }),
      );
    };

    if (opts.interruptionDetection) {
      const [vadInputStream, teedInput] = primaryInputStream.tee();
      const [inputStream, sttInputStream] = teedInput.tee();
      this.vadInputStream = vadInputStream;
      this.sttInputStream = mergeReadableStreams(
        replaceSttInputWithSilence(sttInputStream),
        this.silenceAudioTransform.readable,
      );
      this.interruptionStreamChannel = createStreamChannel();
      this.interruptionStreamChannel.addStreamInput(inputStream);
    } else {
      const [vadInputStream, sttInputStream] = primaryInputStream.tee();
      this.vadInputStream = vadInputStream;
      this.sttInputStream = mergeReadableStreams(
        replaceSttInputWithSilence(sttInputStream),
        this.silenceAudioTransform.readable,
      );
    }
    this.silenceAudioWriter = this.silenceAudioTransform.writable.getWriter();
  }

  /**
   * Current transcript of the user's speech, including interim transcript if available.
   */
  get currentTranscript(): string {
    if (this.audioInterimTranscript) {
      return `${this.audioTranscript} ${this.audioInterimTranscript}`.trim();
    }
    return this.audioTranscript;
  }

  /** @internal */
  get inputStartedAt() {
    return this.sttPipeline?.inputStartedAt;
  }

  /** @internal */
  updateOptions(options: {
    endpointing?: BaseEndpointing;
    turnDetection?: TurnDetectionMode | null;
  }): void {
    if (options.endpointing !== undefined) {
      this.endpointing = options.endpointing;
    }
    if (options.turnDetection !== undefined) {
      this.turnDetectionMode = options.turnDetection ?? undefined;
    }
  }

  /** True iff the user supplied their own VAD (default-VAD is treated as
   * absent at sites that decide between "use VAD signal" and "STT-derived
   * speaking"). */
  private get hasUserVad(): boolean {
    return this.vad !== undefined && !this.usingDefaultVad;
  }

  /**
   * Swap the active turn detector at runtime. When an `BaseStreamingTurnDetector`
   * is provided, opens a per-turn FSM stream after retiring the prior one.
   *
   * When `stream` is provided it is adopted as-is (handoff reuse) instead of
   * opening a fresh stream on `detector`; the live transport stream — and its
   * per-session cloud→local fallback state — survives the handoff.
   */
  updateTurnDetector(
    detector: _TurnDetector | BaseStreamingTurnDetector | undefined,
    options?: { stream?: BaseStreamingTurnDetectorStream },
  ): void {
    // Validate against the incoming detector before swapping in so the error
    // — when raised — names the configuration that failed.
    this.checkVadSilenceRequirement(detector);
    this.turnDetector = detector;

    const reuseStream = options?.stream;
    // Retire the prior stream before creating the new one. `detach()` frees
    // the detector's single-stream slot synchronously (so `stream()` below
    // won't throw if the same detector is reused), while the network teardown
    // runs in the background.
    const oldStream = this.turnDetectorStream;
    if (oldStream !== undefined && oldStream !== reuseStream) {
      oldStream.detach();
      void oldStream.aclose().catch(() => undefined);
    }
    const newStream =
      reuseStream !== undefined
        ? reuseStream
        : detector instanceof BaseStreamingTurnDetector
          ? detector.stream()
          : undefined;
    // A different stream means a fresh request lifecycle: drop any held
    // prediction future and re-arm so the adopting recognition starts its own
    // request on the next VAD event.
    if (this.turnDetectorStream !== newStream) {
      this.turnDetectorPredictionFut = undefined;
      this.turnDetectorFlushed = false;
    }
    this.turnDetectorStream = newStream;
  }

  /**
   * Detach the turn detector stream for handoff to another AudioRecognition.
   *
   * Returns the live stream (transport run loop intact) without closing it.
   * The caller passes it to the new AudioRecognition via
   * `start({ turnDetectorStream })`. The stream stays attached to its
   * detector, retaining the detector's single-stream slot, so the new
   * AudioRecognition must adopt it rather than open a second stream.
   */
  detachTurnDetector(): BaseStreamingTurnDetectorStream | undefined {
    const stream = this.turnDetectorStream;
    this.turnDetectorStream = undefined;
    // The adopting recognition starts a fresh request on its next VAD event,
    // superseding any request that survived the handoff.
    this.turnDetectorPredictionFut = undefined;
    return stream;
  }

  /**
   * The audio EOT detector needs a wider silence window than typical VAD
   * defaults. Rather than mutate the VAD's knob, require the caller to
   * configure it: raise if the bound VAD exposes `minSilenceDuration` and it
   * is below the floor. VADs that don't expose the knob are left untouched.
   */
  private checkVadSilenceRequirement(
    detector: _TurnDetector | BaseStreamingTurnDetector | undefined = this.turnDetector,
  ): void {
    if (!(detector instanceof BaseStreamingTurnDetector) || this.vad === undefined) {
      return;
    }
    const current = this.vad.minSilenceDuration;
    if (current === null) {
      return;
    }
    const required = MIN_SILENCE_DURATION_MS + 50;
    if (current < required) {
      throw new Error(
        `vad minSilenceDuration=${current}ms is too low for the TurnDetector. ` +
          `Raise the VAD's minSilenceDuration to at least ${required}ms.`,
      );
    }
  }

  async start(options?: {
    sttPipeline?: STTPipeline;
    turnDetectorStream?: BaseStreamingTurnDetectorStream;
  }) {
    this.startSttTasks(options?.sttPipeline);

    this.vadTask = Task.from(({ signal }) => this.createVadTask(this.vad, signal));
    this.vadTask.result.catch((err) => {
      this.logger.error(`Error running VAD task: ${err}`);
    });

    this.interruptionTask = Task.from(({ signal }) =>
      this.createInterruptionTask(this.interruptionDetection, signal),
    );
    this.interruptionTask.result.catch((err) => {
      this.logger.error(`Error running interruption task: ${err}`);
    });

    // Open (or adopt) the audio EOT detector stream now that the activity is
    // running. We only call `updateTurnDetector` for BaseStreamingTurnDetector /
    // undefined detectors — plugin-based `_TurnDetector` instances are
    // text-only and don't carry a stream.
    if (this.turnDetector instanceof BaseStreamingTurnDetector || this.turnDetector === undefined) {
      this.updateTurnDetector(this.turnDetector, { stream: options?.turnDetectorStream });
    }
  }

  async stop() {
    await this.sttConsumerTask?.cancelAndWait();
    await this.sttForwardTask?.cancelAndWait();
    await this.vadTask?.cancelAndWait();
    await this.interruptionTask?.cancelAndWait();
    if (this.turnDetectorStream !== undefined) {
      const stream = this.turnDetectorStream;
      this.turnDetectorStream = undefined;
      await stream.aclose().catch(() => undefined);
    }
  }

  async disableInterruptionDetection(): Promise<void> {
    this.isInterruptionEnabled = false;
    this.interruptionDetection = undefined;
    await this.interruptionTask?.cancelAndWait();
    this.interruptionTask = undefined;
    await this.interruptionStreamChannel?.close();
    this.interruptionStreamChannel = undefined;
    this.cancelBackchannelBoundary();
    await this.flushHeldTranscripts(0, true);
  }

  /**
   * Whether the backchannel boundary timer is currently running.
   */
  get backchannelBoundaryActive(): boolean {
    return this.backchannelBoundaryTimer !== undefined;
  }

  /**
   * Fires when the backchannel boundary timer expires naturally. Drops the timer handle and
   * invokes the registered callback exactly once.
   */
  private onBackchannelBoundaryDone(): void {
    this.backchannelBoundaryTimer = undefined;
    const cb = this.backchannelBoundaryCallback;
    this.backchannelBoundaryCallback = undefined;
    cb?.();
  }

  /**
   * Cancel any pending backchannel boundary timer and clear the registered callback.
   */
  cancelBackchannelBoundary(): void {
    if (this.backchannelBoundaryTimer !== undefined) {
      clearTimeout(this.backchannelBoundaryTimer);
      this.backchannelBoundaryTimer = undefined;
    }
    this.backchannelBoundaryCallback = undefined;
  }

  async onStartOfAgentSpeech(startedAt: number) {
    this.isAgentSpeaking = true;
    this.agentSpeechStartedAt = startedAt;
    this.endpointing.onStartOfAgentSpeech(startedAt);
    this.userTurnTracker = { words: 0, transcript: '' };

    if (this.backchannelBoundary && this.backchannelBoundary[0] > 0) {
      this.cancelBackchannelBoundary();
      const startCooldown = this.backchannelBoundary[0];
      this.backchannelBoundaryTimer = setTimeout(
        () => this.onBackchannelBoundaryDone(),
        startCooldown,
      );
    }

    return this.trySendInterruptionSentinel(InterruptionStreamSentinel.agentSpeechStarted());
  }

  async onEndOfAgentSpeech(ignoreUserTranscriptUntil: number) {
    this.cancelBackchannelBoundary();

    const now = Date.now();
    const wasAgentSpeaking = this.isAgentSpeaking;
    // Capture before the assignment below; the overlap-end notification only fires when no
    // overlap had been registered during this agent speech.
    const priorIgnoreUserTranscriptUntil = this.ignoreUserTranscriptUntil;
    if (wasAgentSpeaking) {
      this.endpointing.onEndOfAgentSpeech(now);
    }

    if (!this.isInterruptionEnabled) {
      this.isAgentSpeaking = false;
      return;
    }

    let endCooldown = 0;
    if (wasAgentSpeaking) {
      endCooldown = this.backchannelBoundary ? this.backchannelBoundary[1] : 0;
      const ignoreUntil = this.ignoreUserTranscriptUntil
        ? Math.min(ignoreUserTranscriptUntil, this.ignoreUserTranscriptUntil)
        : ignoreUserTranscriptUntil;
      this.logger.trace({ ignoreUntil, endCooldown }, 'flushing held transcripts');
      // Subtracting `endCooldown` widens the release window so transcripts that ended just
      // before the agent finished speaking (premature corrections) are surfaced.
      this.ignoreUserTranscriptUntil = ignoreUntil - endCooldown;
    }
    // Clear before awaiting the sentinel so STT events arriving while the sentinel is in
    // flight are not buffered.
    this.isAgentSpeaking = false;

    const inputOpen = await this.trySendInterruptionSentinel(
      InterruptionStreamSentinel.agentSpeechEnded(),
    );
    if (!inputOpen) {
      return;
    }

    if (wasAgentSpeaking) {
      // Notify overlap end after the agent-speech-ended sentinel resets the inference stream
      // so it does not emit a synthetic `isInterruption: false` event following a real
      // interruption.
      if (priorIgnoreUserTranscriptUntil === undefined) {
        this.onEndOfOverlapSpeech(Date.now(), undefined, true);
      }
      await this.flushHeldTranscripts(endCooldown);
    }
  }

  /** Start interruption inference when agent is speaking and overlap speech starts. */
  async onStartOfOverlapSpeech(speechDuration: number, startedAt: number, userSpeakingSpan?: Span) {
    if (this.isAgentSpeaking) {
      if (!this.endpointing.overlapping) {
        this.endpointing.onStartOfSpeech(startedAt, true);
      }
      this.turnBackchannelOverAgent = false;
      this.overlapInCurrentTurn = true;
      this.trySendInterruptionSentinel(
        InterruptionStreamSentinel.overlapSpeechStarted(
          speechDuration,
          startedAt,
          userSpeakingSpan,
        ),
      );
    }
  }

  /** End interruption inference when overlap speech ends. */
  async onEndOfOverlapSpeech(endedAt: number, userSpeakingSpan?: Span, agentEnded = false) {
    if (!this.isInterruptionEnabled) {
      return;
    }
    if (userSpeakingSpan && userSpeakingSpan.isRecording()) {
      userSpeakingSpan.setAttribute(traceTypes.ATTR_IS_INTERRUPTION, 'false');
    }

    return this.trySendInterruptionSentinel(
      InterruptionStreamSentinel.overlapSpeechEnded(endedAt, agentEnded),
    );
  }

  /**
   * Flush held transcripts. When `force` is true, all buffered events are emitted during
   * interruption-detector teardown because ignore-window gating can no longer be trusted.
   * Otherwise, only transcripts whose end time is after `ignoreUserTranscriptUntil - cooldown`
   * are emitted. Events without timestamps are treated as the next valid event.
   */
  private async flushHeldTranscripts(cooldown: number = 0, force = false) {
    if (this.transcriptBuffer.length === 0) {
      this.resetInterruptionDetection();
      return;
    }

    if (force) {
      const eventsToEmit = [...this.transcriptBuffer];
      this.resetInterruptionDetection();
      for (const event of eventsToEmit) {
        await this.onSTTEvent(event);
      }
      return;
    }

    if (
      !this.isInterruptionEnabled ||
      this.ignoreUserTranscriptUntil === undefined ||
      this.inputStartedAt === undefined
    ) {
      this.resetInterruptionDetection();
      return;
    }

    let emitFromIndex: number | null = null;
    let shouldFlush = false;

    for (let i = 0; i < this.transcriptBuffer.length; i++) {
      const ev = this.transcriptBuffer[i];
      if (!ev || !ev.alternatives || ev.alternatives.length === 0) {
        emitFromIndex = Math.min(emitFromIndex ?? i, i);
        continue;
      }
      const firstAlternative = ev.alternatives[0];
      if (
        firstAlternative.startTime === firstAlternative.endTime &&
        firstAlternative.startTime === 0
      ) {
        this.resetInterruptionDetection();
        return;
      }

      if (this.#alternativeEndsWithinIgnoreWindow(firstAlternative)) {
        emitFromIndex = null;
      } else {
        emitFromIndex = Math.min(emitFromIndex ?? i, i);
        shouldFlush = true;
        break;
      }
    }

    const eventsToEmit =
      emitFromIndex !== null && shouldFlush ? this.transcriptBuffer.slice(emitFromIndex) : [];

    // Snapshot the ignore-until before resetting so the added-delay diagnostic below mirrors
    // the value the holding decision was made against.
    const prevIgnoreUserTranscriptUntil = this.ignoreUserTranscriptUntil;
    const prevInputStartedAt = this.inputStartedAt;
    this.resetInterruptionDetection();

    for (const event of eventsToEmit) {
      let addedDelay = 0;
      const firstAlternative = event.alternatives?.[0];
      if (
        firstAlternative &&
        firstAlternative.endTime > 0 &&
        prevIgnoreUserTranscriptUntil !== undefined &&
        prevInputStartedAt !== undefined
      ) {
        addedDelay = Math.max(
          0,
          firstAlternative.endTime * 1000 +
            prevInputStartedAt -
            prevIgnoreUserTranscriptUntil +
            cooldown,
        );
      }
      this.logger.trace(
        { event: event.type, cooldown, addedDelay },
        're-emitting held user transcript',
      );
      await this.onSTTEvent(event);
    }
  }

  private resetInterruptionDetection(): void {
    this.transcriptBuffer = [];
    this.ignoreUserTranscriptUntil = undefined;
    // Keep the anchor while a newer agent-speech cycle is active, so a stale flush
    // can't clear an anchor that cycle has already set.
    if (!this.isAgentSpeaking) {
      this.agentSpeechStartedAt = undefined;
    }
  }

  private withinIgnoreWindow(eventTime: number): boolean {
    if (this.ignoreUserTranscriptUntil === undefined) {
      return false;
    }

    const lower = this.agentSpeechStartedAt ?? 0;
    const upper = Math.min(Date.now(), this.ignoreUserTranscriptUntil);
    return lower < eventTime && eventTime < upper;
  }

  #alternativeEndsWithinIgnoreWindow(
    alternative: NonNullable<SpeechEvent['alternatives']>[number],
  ) {
    return (
      alternative.endTime > 0 &&
      this.inputStartedAt !== undefined &&
      this.withinIgnoreWindow(alternative.endTime * 1000 + this.inputStartedAt)
    );
  }

  private shouldHoldSttEvent(ev: SpeechEvent): boolean {
    if (!this.isInterruptionEnabled) {
      return false;
    }
    if (this.isAgentSpeaking) {
      return true;
    }

    // reset when the user starts speaking after the agent speech
    if (ev.type === SpeechEventType.START_OF_SPEECH) {
      this.resetInterruptionDetection();
      return false;
    }

    if (this.ignoreUserTranscriptUntil === undefined) {
      return false;
    }
    // sentinel events are always held until we have something concrete to release them
    if (!ev.alternatives || ev.alternatives.length === 0) {
      return true;
    }

    const alternative = ev.alternatives[0];

    if (
      alternative.startTime !== alternative.endTime &&
      this.inputStartedAt !== undefined &&
      alternative.startTime > 0 &&
      this.withinIgnoreWindow(alternative.startTime * 1000 + this.inputStartedAt)
    ) {
      return true;
    }
    return false;
  }

  private async trySendInterruptionSentinel(
    frame: AudioFrame | InterruptionSentinel,
  ): Promise<boolean> {
    if (
      this.isInterruptionEnabled &&
      this.interruptionStreamChannel &&
      !this.interruptionStreamChannel.closed
    ) {
      try {
        await this.interruptionStreamChannel.write(frame);
        return true;
      } catch (e: unknown) {
        this.logger.warn(
          `could not forward interruption sentinel: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return false;
  }

  private ensureUserTurnSpan(startTime?: number): Span {
    if (this.userTurnSpan && this.userTurnSpan.isRecording()) {
      return this.userTurnSpan;
    }

    startTime ??= Date.now();
    if (this.userTurnStart === undefined) {
      this.userTurnStart = startTime;
    }

    this.userTurnSpan = tracer.startSpan({
      name: 'user_turn',
      context: this.rootSpanContext,
      startTime,
    });

    const participant = this.getLinkedParticipant?.();
    if (participant) {
      setParticipantSpanAttributes(this.userTurnSpan, participant);
    }

    if (this.sttModel) {
      this.userTurnSpan.setAttribute(traceTypes.ATTR_GEN_AI_REQUEST_MODEL, this.sttModel);
    }
    if (this.sttProvider) {
      this.userTurnSpan.setAttribute(traceTypes.ATTR_GEN_AI_PROVIDER_NAME, this.sttProvider);
    }

    return this.userTurnSpan;
  }

  private userTurnContext(span: Span): Context {
    const base = this.rootSpanContext ?? ROOT_CONTEXT;
    return trace.setSpan(base, span);
  }

  private async onSTTEvent(ev: SpeechEvent) {
    // Collect provider-known STT ids for this user turn. The actual attribute is
    // written once when the user_turn span ends (see _endUserTurnSpan), to avoid
    // ordering issues with span creation.
    if (ev.requestId && !this.sttRequestIds.includes(ev.requestId)) {
      this.sttRequestIds.push(ev.requestId);
    }

    if (
      this.turnDetectionMode === 'manual' &&
      this.userTurnCommitted &&
      (this.bounceEOUTask === undefined ||
        this.bounceEOUTask.done ||
        ev.type == SpeechEventType.INTERIM_TRANSCRIPT)
    ) {
      // ignore stt event if user turn already committed and EOU task is done
      // or it's an interim transcript
      this.logger.debug(
        {
          userTurnCommitted: this.userTurnCommitted,
          eouTaskDone: this.bounceEOUTask?.done,
          evType: ev.type,
          turnDetectionMode: this.turnDetectionMode,
        },
        'ignoring stt event',
      );
      return;
    }

    // handle interruption detection
    // - hold the event until the ignore_user_transcript_until expires
    // - release only relevant events
    // - allow RECOGNITION_USAGE to pass through immediately

    if (ev.type !== SpeechEventType.RECOGNITION_USAGE && this.isInterruptionEnabled) {
      if (this.shouldHoldSttEvent(ev)) {
        this.logger.trace(
          { event: ev.type, ignoreUserTranscriptUntil: this.ignoreUserTranscriptUntil },
          'holding STT event until ignore_user_transcript_until expires',
        );
        this.transcriptBuffer.push(ev);
        return;
      } else if (this.transcriptBuffer.length > 0) {
        const endCooldown = this.backchannelBoundary ? this.backchannelBoundary[1] : 0;
        await this.flushHeldTranscripts(endCooldown);
        // no return here to allow the new event to be processed normally
      }
    }

    const firstAlternative = ev.alternatives?.[0];
    const inputStartedAt = this.inputStartedAt;
    const hasSTTEndTime =
      firstAlternative !== undefined &&
      firstAlternative.endTime > 0 &&
      inputStartedAt !== undefined;
    // clamp to now: a reused STT stream's clock can be far ahead of this
    // activity's input epoch (e.g. after a handoff), and a future
    // lastSpeakingTime would stall the EOU bounce task for that long
    // (1.4.5 silence regression from #1603; see audio_recognition_eou.test.ts)
    const sttLastSpeakingTime = hasSTTEndTime
      ? Math.min(firstAlternative.endTime * 1000 + inputStartedAt, Date.now())
      : Date.now();

    switch (ev.type) {
      case SpeechEventType.FINAL_TRANSCRIPT:
        const transcript = ev.alternatives?.[0]?.text;
        const confidence = ev.alternatives?.[0]?.confidence ?? 0;
        this.lastLanguage = ev.alternatives?.[0]?.language;

        if (!transcript) {
          // stt final transcript received but no transcript
          return;
        }

        this.hooks.onFinalTranscript(
          ev,
          this.hasUserVad || this.turnDetectionMode === 'stt' ? this.speaking : undefined,
        );

        this.logger.debug(
          {
            user_transcript: transcript,
            language: this.lastLanguage,
          },
          'received user transcript',
        );

        this.lastFinalTranscriptTime = Date.now();
        this.audioTranscript += ` ${transcript}`;
        this.audioTranscript = this.audioTranscript.trimStart();
        this.finalTranscriptConfidence.push(confidence);
        const transcriptChanged = this.audioTranscript !== this.audioPreflightTranscript;
        this.audioInterimTranscript = '';
        this.audioPreflightTranscript = '';

        if (!this.hasUserVad || this.lastSpeakingTime === undefined) {
          // vad disabled or missed a speech, use stt timestamp
          this.lastSpeakingTime = sttLastSpeakingTime;
        }

        this.checkUserTurnLimit(transcript);

        if (this.vadBaseTurnDetection || this.userTurnCommitted) {
          if (transcriptChanged) {
            this.logger.debug(
              { transcript: this.audioTranscript },
              'triggering preemptive generation (FINAL_TRANSCRIPT)',
            );
            this.hooks.onPreemptiveGeneration({
              newTranscript: this.audioTranscript,
              transcriptConfidence:
                this.finalTranscriptConfidence.length > 0
                  ? this.finalTranscriptConfidence.reduce((a, b) => a + b, 0) /
                    this.finalTranscriptConfidence.length
                  : 0,
              startedSpeakingAt: this.speechStartTime,
            });
          }

          if (!this.speaking) {
            const chatCtx = this.hooks.retrieveChatCtx();
            this.logger.debug('running EOU detection on stt FINAL_TRANSCRIPT');
            this.runEOUDetection(chatCtx, 'stt');
          }
        }
        break;
      case SpeechEventType.PREFLIGHT_TRANSCRIPT:
        this.hooks.onInterimTranscript(
          ev,
          this.hasUserVad || this.turnDetectionMode === 'stt' ? this.speaking : undefined,
        );
        const preflightTranscript = ev.alternatives?.[0]?.text ?? '';
        const preflightConfidence = ev.alternatives?.[0]?.confidence ?? 0;
        const preflightLanguage = ev.alternatives?.[0]?.language;

        const MIN_LANGUAGE_DETECTION_LENGTH = 5;
        if (
          !this.lastLanguage ||
          (preflightLanguage && preflightTranscript.length > MIN_LANGUAGE_DETECTION_LENGTH)
        ) {
          this.lastLanguage = preflightLanguage;
        }

        if (!preflightTranscript) {
          return;
        }

        this.logger.debug(
          {
            user_transcript: preflightTranscript,
            language: this.lastLanguage,
          },
          'received user preflight transcript',
        );

        // still need to increment it as it's used for turn detection,
        this.lastFinalTranscriptTime = Date.now();
        // preflight transcript includes all pre-committed transcripts (including final transcript from the previous STT run)
        this.audioPreflightTranscript =
          `${this.audioTranscript} ${preflightTranscript}`.trimStart();
        this.audioInterimTranscript = preflightTranscript;

        if (!this.hasUserVad || this.lastSpeakingTime === undefined) {
          // vad disabled or missed a speech, use stt timestamp
          this.lastSpeakingTime = sttLastSpeakingTime;
        }

        if (this.turnDetectionMode !== 'manual' || this.userTurnCommitted) {
          const confidenceVals = [...this.finalTranscriptConfidence, preflightConfidence];
          this.logger.debug(
            {
              transcript:
                this.audioPreflightTranscript.length > 100
                  ? this.audioPreflightTranscript.slice(0, 100) + '...'
                  : this.audioPreflightTranscript,
            },
            'triggering preemptive generation (PREFLIGHT_TRANSCRIPT)',
          );
          this.hooks.onPreemptiveGeneration({
            newTranscript: this.audioPreflightTranscript,
            transcriptConfidence:
              confidenceVals.length > 0
                ? confidenceVals.reduce((a, b) => a + b, 0) / confidenceVals.length
                : 0,
            startedSpeakingAt: this.speechStartTime,
          });
        }
        break;
      case SpeechEventType.INTERIM_TRANSCRIPT:
        this.logger.debug({ transcript: ev.alternatives?.[0]?.text }, 'interim transcript');
        this.hooks.onInterimTranscript(
          ev,
          this.hasUserVad || this.turnDetectionMode === 'stt' ? this.speaking : undefined,
        );
        this.audioInterimTranscript = ev.alternatives?.[0]?.text ?? '';
        break;
      case SpeechEventType.START_OF_SPEECH:
        if (this.turnDetectionMode !== 'stt') break;
        {
          const speechStartTime = Date.now();
          const span = this.ensureUserTurnSpan(speechStartTime);
          const ctx = this.userTurnContext(span);
          this.endpointing.onStartOfSpeech(speechStartTime, this.isAgentSpeaking);
          this.interruptionDetected = undefined;
          this.turnBackchannelOverAgent = false;
          this.overlapInCurrentTurn = this.isAgentSpeaking;
          otelContext.with(ctx, () => {
            this.hooks.onStartOfSpeech({
              type: VADEventType.START_OF_SPEECH,
              samplesIndex: 0,
              timestamp: Date.now(),
              speechDuration: 0,
              silenceDuration: 0,
              frames: [],
              probability: 0,
              inferenceDuration: 0,
              speaking: true,
              rawAccumulatedSilence: 0,
              rawAccumulatedSpeech: 0,
            });
          });
        }
        this.speaking = true;
        this.lastSpeakingTime = sttLastSpeakingTime;
        this.bounceEOUTask?.cancel();
        break;
      case SpeechEventType.END_OF_SPEECH:
        if (this.turnDetectionMode !== 'stt') break;
        {
          const speechEndTime = Date.now();
          const span = this.ensureUserTurnSpan();
          const ctx = this.userTurnContext(span);
          if (this.speaking) {
            this.endpointing.onEndOfSpeech(
              speechEndTime,
              this.interruptionDetected === false && this.isAgentSpeaking,
            );
          }
          otelContext.with(ctx, () => {
            this.hooks.onEndOfSpeech({
              type: VADEventType.END_OF_SPEECH,
              samplesIndex: 0,
              timestamp: Date.now(),
              speechDuration: 0,
              silenceDuration: 0,
              frames: [],
              probability: 0,
              inferenceDuration: 0,
              speaking: false,
              rawAccumulatedSilence: 0,
              rawAccumulatedSpeech: 0,
            });
          });
        }
        // STT EOT changes user state from speaking to listening without updating VAD internal states.
        // VAD EOS will also skip updating user state from listening (STT enforced) to listening (VAD detected)
        // and user state won't be updated until a new VAD SOS is received.
        // Reset VAD so that incorrect end of turn from STT can be corrected by VAD interruption.
        // If user is still speaking (an immediate VAD SOS will interrupt the agent).
        // Default-bundled VAD is treated as absent here — only user-supplied VADs
        // are reset/flushed, matching the matrix in PR_DESCRIPTION.
        if (this.hasUserVad && this.vadSpeechStarted) {
          if (this.vadStream) {
            this.vadStream.flush();
          } else {
            this.resetVad();
          }

          this.logger.warn(
            {
              vadSpeechStartTime: this.speechStartTime,
              flushed: this.vadStream !== undefined,
            },
            'stt end of speech received while vad is still in a speech segment, flushing vad',
          );
        }
        this.speaking = false;
        this.userTurnCommitted = true;
        if (!this.hasUserVad || this.lastSpeakingTime === undefined) {
          // vad disabled or missed a speech, use stt timestamp
          this.lastSpeakingTime = sttLastSpeakingTime;
        }

        if (!this.speaking) {
          const chatCtx = this.hooks.retrieveChatCtx();
          this.logger.debug('running EOU detection on stt END_OF_SPEECH');
          this.runEOUDetection(chatCtx, 'stt');
        }
    }
  }

  private onOverlapSpeechEvent(ev: OverlappingSpeechEvent) {
    if (this.backchannelBoundaryActive && !ev.isInterruption) {
      this.logger.trace(
        'ignoring backchannel event during backchannel boundary cooldown, falling back to vad',
      );
      return;
    }

    this.interruptionDetected = ev.isInterruption;

    if (this.overlapInCurrentTurn && !ev.agentEnded) {
      this.turnBackchannelOverAgent = !ev.isInterruption;
      if (!ev.isInterruption && !this.speaking) {
        this.hooks.onBackchannelConfirmed();
      }
    }

    if (ev.isInterruption) {
      this.hooks.onInterruption(ev);
    }
  }

  private onMissingEotPrediction(): void {
    if (this.turnDetectorFlushed) {
      if (!this.turnDetectorLatePredictionWarned) {
        this.turnDetectorLatePredictionWarned = true;
        this.logger.warn(
          'transcript arrives after turn has been committed. consider raising `minDelay` in the ' +
            'endpointing options to accommodate a slow stt. subsequent ' +
            'occurrences will log at debug level.',
        );
      } else {
        this.logger.debug('stt transcript arrived after a turn flush, skipping eot prediction');
      }
    } else {
      this.logger.debug('no eot inference request in flight, skipping eot prediction');
    }
  }

  private runEOUDetection(chatCtx: ChatContext, trigger: 'vad' | 'stt' | 'manual' = 'vad') {
    this.logger.debug(
      {
        stt: this.stt,
        audioTranscript: this.audioTranscript,
        turnDetectionMode: this.turnDetectionMode,
      },
      'running EOU detection',
    );

    if (this.stt && !this.audioTranscript && this.turnDetectionMode !== 'manual') {
      // stt enabled but no transcript yet
      this.logger.debug('skipping EOU detection');
      return;
    }

    chatCtx = chatCtx.copy();
    if (this.audioTranscript) {
      chatCtx.addMessage({ role: 'user', content: this.audioTranscript });
    }

    // Pick the right detector:
    //  - manual mode: no detector (turn boundary decided externally)
    //  - audio EOT detector: prefer the per-turn stream (it caches the
    //    prediction for the current inference window so the bounce task
    //    can short-circuit on cache)
    //  - text-based detector: only run when we have a transcript to score
    const hasAudioDetector = this.turnDetector instanceof BaseStreamingTurnDetector;
    const useDetector =
      this.turnDetectionMode !== 'manual' && (this.audioTranscript || hasAudioDetector);
    // The unified type only covers the predict surface; the audio
    // detector's per-turn stream stands in for the parent when one is
    // attached so the cached prediction is available.
    let turnDetector: _TurnDetector | BaseStreamingTurnDetectorStream | undefined;
    if (!useDetector) {
      turnDetector = undefined;
    } else if (hasAudioDetector) {
      turnDetector = this.turnDetectorStream;
    } else {
      // text-based detector — `this.turnDetector` cannot be the audio
      // base class here, because `hasAudioDetector` already screened it.
      turnDetector = this.turnDetector as _TurnDetector | undefined;
    }

    const bounceEOUTask =
      (
        lastSpeakingTime: number | undefined,
        lastFinalTranscriptTime: number,
        speechStartTime: number | undefined,
      ) =>
      async (controller: AbortController) => {
        let endpointingDelay = this.endpointing.minDelay;

        const userTurnSpan = this.ensureUserTurnSpan();
        const userTurnCtx = this.userTurnContext(userTurnSpan);

        if (turnDetector) {
          if (!(await turnDetector.supportsLanguage(this.lastLanguage))) {
            // Unsupported language: produce no span and emit no prediction event.
            this.logger.debug(`Turn detector does not support language ${this.lastLanguage}`);
          } else {
            await tracer.startActiveSpan(
              async (span) => {
                this.logger.debug('Running turn detector model');

                // undefined => the prediction never resolved (e.g. timed out
                // or inference threw); gates the span attributes and the emit
                // below.
                let endOfTurnProbability: number | undefined;
                let unlikelyThreshold: number | undefined;
                let backchannelThreshold: number | undefined;
                // True when the held future was already resolved when this
                // bounce started — i.e. the prediction was served from the
                // request the silence tick warmed, not awaited fresh.
                let fromCache = false;
                // The resolved prediction event for this turn, shared by
                // reference across both EOU triggers (vad + stt final) so the
                // emit can dedupe.
                let predictionEvent: TurnDetectionEvent | undefined;

                if (turnDetector instanceof BaseStreamingTurnDetectorStream) {
                  const fut = this.turnDetectorPredictionFut;
                  if (fut === undefined) {
                    if (trigger === 'stt') {
                      this.onMissingEotPrediction();
                    }
                  } else {
                    fromCache = fut.done;
                    // Await the held future against the model prediction timeout.
                    const predictionTimeout = turnDetector.predictionTimeout;
                    let timeoutId: ReturnType<typeof setTimeout> | undefined;
                    const winner = await Promise.race([
                      fut.await.then((ev) => ({ kind: 'value', ev }) as const),
                      new Promise<{ kind: 'timeout' }>((resolve) => {
                        timeoutId = setTimeout(
                          () => resolve({ kind: 'timeout' }),
                          predictionTimeout,
                        );
                      }),
                    ]);
                    if (timeoutId !== undefined) clearTimeout(timeoutId);

                    // A newer trigger calls `bounceEOUTask?.cancel()`. A JS abort
                    // does NOT interrupt the await above, so bail here before
                    // touching shared state so the superseded bounce doesn't
                    // clobber a freshly-armed future or double-emit.
                    if (controller.signal.aborted) return;

                    if (winner.kind === 'value') {
                      predictionEvent = winner.ev;
                      endOfTurnProbability = predictionEvent.endOfTurnProbability;
                      unlikelyThreshold = await turnDetector.unlikelyThreshold(this.lastLanguage);
                      backchannelThreshold = await turnDetector.backchannelThreshold(
                        this.lastLanguage,
                      );
                    } else {
                      this.logger.warn(
                        { timeoutMs: predictionTimeout },
                        'eot prediction timed out, committing without a prediction',
                      );
                      turnDetector.cancelInference({ timedOut: true });
                      this.turnDetectorPredictionFut = undefined;
                    }
                  }
                } else {
                  try {
                    endOfTurnProbability = await turnDetector.predictEndOfTurn(chatCtx);
                    unlikelyThreshold = await turnDetector.unlikelyThreshold(this.lastLanguage);
                  } catch (error) {
                    this.logger.error(error, 'Error predicting end of turn');
                  }
                  // See the streaming-branch note: bail if a newer trigger
                  // superseded this bounce while it awaited.
                  if (controller.signal.aborted) return;
                }

                if (
                  endOfTurnProbability !== undefined &&
                  unlikelyThreshold !== undefined &&
                  endOfTurnProbability < unlikelyThreshold
                ) {
                  endpointingDelay = this.endpointing.maxDelay;
                }

                this.logger.debug(
                  {
                    endOfTurnProbability,
                    unlikelyThreshold,
                    endpointingDelay,
                    language: this.lastLanguage,
                    trigger,
                    fromCache,
                  },
                  'eot prediction',
                );

                const prediction = predictionEvent;

                span.setAttribute(
                  traceTypes.ATTR_CHAT_CTX,
                  // snake_case wire shape, matching Python's EOU span: trim to the last
                  // few items and drop function calls, instructions, empty messages,
                  // handoffs, and config updates, so the span doesn't re-emit the whole
                  // conversation on every EOU inference.
                  JSON.stringify(
                    toSnakeCaseDeep(
                      new ChatContext(chatCtx.items.slice(-EOU_MAX_HISTORY_TURNS))
                        .copy({
                          excludeFunctionCall: true,
                          excludeInstructions: true,
                          excludeEmptyMessage: true,
                          excludeHandoff: true,
                          excludeConfigUpdate: true,
                        })
                        .toJSON({ excludeTimestamp: false }),
                    ),
                  ),
                );
                if (endOfTurnProbability !== undefined) {
                  span.setAttribute(traceTypes.ATTR_EOU_PROBABILITY, endOfTurnProbability);
                }
                if (unlikelyThreshold !== undefined) {
                  span.setAttribute(traceTypes.ATTR_EOU_UNLIKELY_THRESHOLD, unlikelyThreshold);
                }
                span.setAttribute(traceTypes.ATTR_EOU_DELAY, endpointingDelay);
                span.setAttribute(traceTypes.ATTR_EOU_LANGUAGE, this.lastLanguage ?? '');
                span.setAttribute(traceTypes.ATTR_EOU_FROM_CACHE, fromCache);
                span.setAttribute(traceTypes.ATTR_EOU_SOURCE, trigger);

                // Emit once the prediction resolved (a timeout / failed
                // inference emits nothing). Both EOU triggers in a turn (vad +
                // stt final) read the same resolved `TurnDetectionEvent`; dedupe
                // by reference so the event fires once per request. The abort
                // guard above drops a superseded bounce; this reference check
                // catches the race where the first bounce completes (and emits)
                // just before the second trigger fires. Text detectors have no
                // shared event (`prediction === undefined`), so they always emit.
                if (
                  endOfTurnProbability !== undefined &&
                  unlikelyThreshold !== undefined &&
                  (prediction === undefined || prediction !== this.lastEmittedEotPrediction)
                ) {
                  this.lastEmittedEotPrediction = prediction;
                  const inferenceDurationMs = prediction?.inferenceDuration ?? 0;
                  const delayMs =
                    lastSpeakingTime !== undefined ? Date.now() - lastSpeakingTime : 0;
                  this.hooks.onEotPrediction(
                    createEotPredictionEvent({
                      probability: endOfTurnProbability,
                      threshold: unlikelyThreshold,
                      inferenceDurationMs,
                      delayMs,
                    }),
                  );

                  // Surface the backchannel opportunity whenever it clears its
                  // threshold, regardless of end-of-turn; AgentActivity decides
                  // whether to acknowledge mid-turn or let it lead the reply.
                  // Shares the eot-emit dedupe so it fires once per request.
                  const backchannelProbability = prediction?.backchannelProbability;
                  if (
                    backchannelProbability !== undefined &&
                    backchannelThreshold !== undefined &&
                    backchannelProbability >= backchannelThreshold
                  ) {
                    this.hooks.onAgentBackchannelOpportunity(
                      _createAgentBackchannelOpportunityEvent({
                        probability: backchannelProbability,
                        threshold: backchannelThreshold,
                        endOfTurnProbability,
                        endOfTurnThreshold: unlikelyThreshold,
                        language: this.lastLanguage,
                      }),
                    );
                  }
                }

                if (prediction?.detectionDelay !== undefined) {
                  span.setAttribute(traceTypes.ATTR_EOU_DETECTION_DELAY, prediction.detectionDelay);
                }
              },
              {
                name: 'eou_detection',
                context: userTurnCtx,
              },
            );
          }
        }

        let extraSleep = endpointingDelay;
        if (lastSpeakingTime !== undefined) {
          extraSleep += lastSpeakingTime - Date.now();
        }

        if (extraSleep > 0) {
          // add delay to see if there's a potential upcoming EOU task that cancels this one
          await delay(Math.max(extraSleep, 0), { signal: controller.signal });
        }

        if (controller.signal.aborted) {
          return;
        }

        // Re-check the creation-time transcript guard at fire time. The commit path
        // (`onEndOfTurn`) awaits, so another bounce can be created in the window between
        // an earlier bounce reading the transcript and resetting it — that newer bounce
        // passes the guard at creation, then wakes up here after the transcript was
        // already committed and cleared. Without this check it commits a duplicate,
        // empty user turn (with stale metrics) and triggers a spurious reply. Python
        // avoids this via preemptive task cancellation and a synchronous commit.
        if (this.stt && !this.audioTranscript && this.turnDetectionMode !== 'manual') {
          this.logger.debug('skipping EOU commit, transcript was already committed');
          return;
        }

        this.logger.debug({ transcript: this.audioTranscript }, 'end of user turn');

        const confidenceAvg =
          this.finalTranscriptConfidence.length > 0
            ? this.finalTranscriptConfidence.reduce((a, b) => a + b, 0) /
              this.finalTranscriptConfidence.length
            : 0;

        // sometimes, we can't calculate the metrics because VAD was unreliable or
        // the speaking anchor is stale/out-of-order. in this case, we just ignore the
        // calculation, it's better than providing likely wrong values
        const metrics = computeEndOfTurnMetrics({
          speechStartTime,
          lastSpeakingTime,
          lastFinalTranscriptTime,
          now: Date.now(),
        });

        const committed = await this.hooks.onEndOfTurn({
          newTranscript: this.audioTranscript,
          transcriptConfidence: confidenceAvg,
          transcriptionDelay: metrics.transcriptionDelay,
          endOfUtteranceDelay: metrics.endOfUtteranceDelay,
          startedSpeakingAt: metrics.startedSpeakingAt,
          stoppedSpeakingAt: metrics.stoppedSpeakingAt,
          backchannelOverAgent: this.turnBackchannelOverAgent,
        });

        if (committed) {
          this._endUserTurnSpan({
            transcript: this.audioTranscript,
            confidence: confidenceAvg,
            transcriptionDelay: metrics.transcriptionDelay ?? 0,
            endOfUtteranceDelay: metrics.endOfUtteranceDelay ?? 0,
          });

          // clear the transcript if the user turn was committed
          this.audioTranscript = '';
          this.finalTranscriptConfidence = [];
          this.lastFinalTranscriptTime = 0;
          // Concurrent user speech might have changed it; only reset if there is no new speech.
          if (this.lastSpeakingTime === lastSpeakingTime) {
            this.speechStartTime = undefined;
            this.vadSpeechStarted = false;
            this.lastSpeakingTime = undefined;
          }

          // Flush the in-flight request and write the turn-boundary sentinel to
          // the transport so the next turn's predict starts fresh — the normal
          // EOU-commit path, mirroring clearUserTurn()'s flush on interrupt.
          if (this.turnDetectorStream !== undefined) {
            this.turnDetectorStream.flush('turn committed');
            this.turnDetectorPredictionFut = undefined;
            this.turnDetectorFlushed = true;
          }
        }

        this.turnBackchannelOverAgent = false;
        this.overlapInCurrentTurn = false;
        this.userTurnCommitted = false;
      };

    // cancel any existing EOU task
    this.bounceEOUTask?.cancel();
    // copy the values before awaiting (the values can change)
    const lastSpeakingTime = this.lastSpeakingTime;
    const lastFinalTranscriptTime = this.lastFinalTranscriptTime;
    const speechStartTime = this.userTurnStart;

    this.bounceEOUTask = Task.from(
      bounceEOUTask(lastSpeakingTime, lastFinalTranscriptTime, speechStartTime),
    );

    this.bounceEOUTask.result
      .then(() => {
        this.logger.debug('EOU detection task completed');
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          // ignore aborted errors
          return;
        }
        this.logger.error(err, 'Error in EOU detection task:');
      });
  }

  async waitForEndOfTurnTask(): Promise<void> {
    if (!this.bounceEOUTask || this.bounceEOUTask.done) {
      return;
    }

    try {
      await this.bounceEOUTask.result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      throw error;
    }
  }

  private checkUserTurnLimit(transcript: string): void {
    const maxWords = this.userTurnLimit?.maxWords ?? null;
    const maxDuration = this.userTurnLimit?.maxDuration ?? null;

    if (maxWords === null && maxDuration === null) {
      return;
    }

    const now = Date.now();
    this.userTurnTracker.startedAt ??= this.speechStartTime ?? now;
    this.userTurnTracker.words += splitWords(transcript, true).length;
    this.userTurnTracker.transcript = `${this.userTurnTracker.transcript} ${transcript}`.trim();

    const duration = now - this.userTurnTracker.startedAt;
    const timeExceeded = maxDuration !== null && duration >= maxDuration;
    const wordsExceeded = maxWords !== null && this.userTurnTracker.words >= maxWords;

    if (!timeExceeded && !wordsExceeded) {
      return;
    }

    this.hooks.onUserTurnExceeded(
      createUserTurnExceededEvent({
        transcript: this.currentTranscript,
        accumulatedTranscript: this.userTurnTracker.transcript,
        accumulatedWordCount: this.userTurnTracker.words,
        duration,
      }),
    );
  }

  private startSttTasks(reusePipeline?: STTPipeline) {
    if (!this.stt) return;

    this.sttPipeline = reusePipeline ?? new STTPipeline(this.stt);

    this.transcriptBuffer = [];
    this.ignoreUserTranscriptUntil = undefined;
    this.sttOwnershipTransferred = false;

    const pipeline = this.sttPipeline;

    this.sttForwardTask = Task.from(({ signal }) => this.forwardInputAudioToStt(pipeline, signal));
    this.sttForwardTask.result.catch((err) => {
      this.logger.error(`Error forwarding audio to STT pipeline: ${err}`);
    });

    this.sttConsumerTask = Task.from(({ signal }) => this.consumeSttEvents(pipeline, signal));
    this.sttConsumerTask.result.catch((err) => {
      this.logger.error(`Error running STT task: ${err}`);
    });
  }

  private async stopSttTasks() {
    await this.sttConsumerTask?.cancelAndWait();
    this.sttConsumerTask = undefined;
    await this.sttForwardTask?.cancelAndWait();
    this.sttForwardTask = undefined;
  }

  async detachSttPipeline(): Promise<STTPipeline | undefined> {
    const unlock = await this.sttLifecycleLock.lock();
    try {
      const pipeline = this.sttPipeline;
      this.sttPipeline = undefined;
      this.sttOwnershipTransferred = pipeline !== undefined;

      await this.sttConsumerTask?.cancelAndWait();
      this.sttConsumerTask = undefined;

      return pipeline;
    } finally {
      unlock();
    }
  }

  private async forwardInputAudioToStt(pipeline: STTPipeline, signal: AbortSignal) {
    for await (const frame of readStream(this.sttInputStream, signal)) {
      const frameDurationMs = (frame.samplesPerChannel / frame.sampleRate) * 1000;
      pipeline.inputStartedAt ??= Date.now() - frameDurationMs;
      await pipeline.audioChannel.write(frame);
    }
  }

  private async consumeSttEvents(pipeline: STTPipeline, signal: AbortSignal) {
    for await (const ev of readStream(pipeline.eventChannel.stream(), signal)) {
      await this.onSTTEvent(ev);
    }
  }

  private async createVadTask(vad: VAD | undefined, signal: AbortSignal) {
    if (!vad) return;

    const vadStream = vad.stream();
    this.vadStream = vadStream;
    vadStream.updateInputStream(this.vadInputStream);

    const abortHandler = () => {
      vadStream.detachInputStream();
      vadStream.close();
      signal.removeEventListener('abort', abortHandler);
    };
    signal.addEventListener('abort', abortHandler);

    try {
      for await (const ev of vadStream) {
        if (signal.aborted) break;

        switch (ev.type) {
          case VADEventType.START_OF_SPEECH:
            this.logger.debug('VAD task: START_OF_SPEECH');
            {
              const startTime = Date.now() - ev.speechDuration - ev.inferenceDuration;
              if (!this.vadSpeechStarted) {
                this.speechStartTime = startTime;
                this.vadSpeechStarted = true;
              }
              const span = this.ensureUserTurnSpan(startTime);
              const ctx = this.userTurnContext(span);
              this.endpointing.onStartOfSpeech(startTime, this.isAgentSpeaking);
              this.interruptionDetected = undefined;
              this.turnBackchannelOverAgent = false;
              this.overlapInCurrentTurn = this.isAgentSpeaking;
              otelContext.with(ctx, () => this.hooks.onStartOfSpeech(ev));
            }
            this.speaking = true;

            // Audio EOT: tear down any in-flight inference for the now-stale
            // prior window and re-arm so the next silence tick starts fresh.
            this.turnDetectorStream?.cancelInference();
            this.turnDetectorPredictionFut = undefined;
            this.turnDetectorFlushed = false;

            // Capture sample rate from the first VAD event if not already set
            if (ev.frames.length > 0 && ev.frames[0]) {
              this.sampleRate = ev.frames[0].sampleRate;
            }

            this.bounceEOUTask?.cancel();
            break;
          case VADEventType.INFERENCE_DONE:
            this.hooks.onVADInferenceDone(ev);
            // for metrics, get the "earliest" signal of speech as possible
            if (ev.rawAccumulatedSpeech > 0.0) {
              this.lastSpeakingTime = Date.now();

              if (this.speechStartTime === undefined) {
                // Backdate speechStartTime to the actual start of accumulated speech.
                // ev.rawAccumulatedSpeech is in ms (VADEvent durations are all ms in TS).
                this.speechStartTime = Date.now() - ev.rawAccumulatedSpeech;
              }
              // A short intra-segment pause can resolve a request before VAD
              // emits END_OF_SPEECH. When speech resumes (without a new SOS),
              // drop that request so the next pause gets a fresh window.
              if (this.speaking && this.turnDetectorPredictionFut !== undefined) {
                this.turnDetectorStream?.cancelInference();
                this.turnDetectorPredictionFut = undefined;
              }
            }

            // Audio EOT: start an inference request once we've seen enough
            // trailing silence (`MIN_SILENCE_DURATION_MS`), but only when no
            // request is already in flight. The silence tick
            // is the sole request trigger — and it warms even while the agent
            // is speaking so an overlapping/interrupting turn still gets a
            // window.
            if (
              ev.rawAccumulatedSilence >= MIN_SILENCE_DURATION_MS &&
              this.speaking &&
              this.turnDetectorStream !== undefined &&
              this.turnDetectorPredictionFut === undefined
            ) {
              this.turnDetectorPredictionFut = this.turnDetectorStream.predict();
            }
            break;
          case VADEventType.END_OF_SPEECH:
            this.logger.debug('VAD task: END_OF_SPEECH');
            {
              const endTime = Date.now() - ev.silenceDuration - ev.inferenceDuration;
              const span = this.ensureUserTurnSpan();
              const ctx = this.userTurnContext(span);
              if (this.speaking) {
                this.endpointing.onEndOfSpeech(
                  endTime,
                  this.interruptionDetected === false && this.isAgentSpeaking,
                );
              }
              otelContext.with(ctx, () => this.hooks.onEndOfSpeech(ev));
            }

            // when VAD fires END_OF_SPEECH, it already waited for the silence_duration
            this.vadSpeechStarted = false;
            this.speaking = false;
            this.lastSpeakingTime = Date.now() - ev.silenceDuration - ev.inferenceDuration;

            // Audio EOT: the silence tick owns request-starting, not
            // END_OF_SPEECH. EOS consumes the already-armed future (if any)
            // and runs the eou bounce.

            if (
              this.vadBaseTurnDetection ||
              (this.turnDetectionMode === 'stt' && this.userTurnCommitted)
            ) {
              const chatCtx = this.hooks.retrieveChatCtx();
              this.runEOUDetection(chatCtx, 'vad');
            }
            break;
        }
      }
    } catch (e) {
      this.logger.error(e, 'Error in VAD task');
    } finally {
      this.logger.debug('VAD task closed');
      if (this.vadStream === vadStream) {
        this.vadStream = undefined;
      }
    }
  }

  private async createInterruptionTask(
    interruptionDetection: AdaptiveInterruptionDetector | undefined,
    signal: AbortSignal,
  ) {
    if (!interruptionDetection || !this.interruptionStreamChannel) return;

    let numRetries = 0;
    const maxRetries = apiConnectDefaults.maxRetries;

    while (!signal.aborted) {
      const stream = interruptionDetection.createStream();
      const eventReader = stream.stream().getReader();

      const cleanup = async () => {
        try {
          signal.removeEventListener('abort', cleanup);
          eventReader.releaseLock();
          await stream.close();
        } catch (e) {
          this.logger.debug('createInterruptionTask: error during cleanup:', e);
        }
      };

      signal.addEventListener('abort', cleanup, { once: true });

      let forwardTask: Promise<void> | undefined;

      try {
        // Unlike Python where _agent_speech_started lives on `self` and survives retries,
        // JS creates a fresh InterruptionStreamBase per retry with agentSpeechStarted = false.
        // Re-inject the sentinel so the new stream knows the agent is mid-speech.
        if (numRetries > 0 && this.isAgentSpeaking) {
          await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
        }

        forwardTask = (async () => {
          const inputReader = this.interruptionStreamChannel!.stream().getReader();
          const abortPromise = waitForAbort(signal);

          try {
            while (!signal.aborted) {
              const res = await ThrowsPromise.race([inputReader.read(), abortPromise]);
              if (!res) break;

              const { value, done } = res;
              if (done) break;

              await stream.pushFrame(value);
            }
          } finally {
            inputReader.releaseLock();
          }
        })();

        const abortPromise = waitForAbort(signal);

        while (!signal.aborted) {
          const res = await ThrowsPromise.race([eventReader.read(), abortPromise]);
          if (!res) break;
          const { done, value: ev } = res;
          if (done) break;
          // A healthy stream delivering events recovers the failover budget, so a later transient
          // failure isn't charged against earlier ones.
          numRetries = 0;
          this.onOverlapSpeechEvent(ev);
        }
        break;
      } catch (e) {
        if (signal.aborted) break;

        if (isAPIError(e)) {
          if (maxRetries === 0 || !e.retryable) {
            interruptionDetection.emitError(
              new InterruptionDetectionError(
                e.message,
                Date.now(),
                interruptionDetection.label,
                false,
              ),
            );
            break;
          } else if (numRetries >= maxRetries) {
            interruptionDetection.emitError(
              new InterruptionDetectionError(
                `failed to detect interruption after ${numRetries} attempts`,
                Date.now(),
                interruptionDetection.label,
                false,
              ),
            );
            break;
          } else {
            const retryInterval = intervalForRetry(numRetries);
            interruptionDetection.emitError(
              new InterruptionDetectionError(
                e.message,
                Date.now(),
                interruptionDetection.label,
                true,
              ),
            );
            this.logger.warn(
              { model: interruptionDetection.label, attempt: numRetries },
              `failed to detect interruption, retrying in ${retryInterval}ms`,
            );
            numRetries++;
            await delay(retryInterval, { signal });
          }
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          interruptionDetection.emitError(
            new InterruptionDetectionError(msg, Date.now(), interruptionDetection.label, false),
          );
          this.logger.error(e, 'Error in interruption task');
          break;
        }
      } finally {
        await cleanup();
        await forwardTask?.catch((e) => {
          this.logger.debug({ err: e }, 'interruption task exited with error');
        });
      }
    }
    this.logger.debug('Interruption task closed');
  }

  setInputAudioStream(audioStream: ReadableStream<AudioFrame>) {
    this.deferredInputStream.setSource(audioStream);
  }

  detachInputAudioStream() {
    this.deferredInputStream.detachSource();
  }

  /**
   * Returns an independent ReadableStream of input audio frames. Each call
   * returns a fresh branch fed by the broadcast transform inserted into the
   * deferred input pipeline — frames written after the subscription point
   * will be delivered, but earlier frames are not replayed.
   *
   * Used by AMD when its private STT needs the same participant audio that
   * the pipeline is processing without consuming it (see python AMD
   * detector pushing audio into `_AMDClassifier.push_audio`).
   */
  subscribeAudioStream(): ReadableStream<AudioFrame> {
    const transform = new IdentityTransform<AudioFrame>();
    const writer = transform.writable.getWriter();
    this.subscriberWriters.push(writer);
    // Auto-prune the entry once the subscriber's readable side is cancelled
    // or its writer otherwise errors. Without this, a subscriber that hands
    // back its stream (e.g. AMD's STT pump after `aclose()`) leaves a writer
    // in `subscriberWriters` that the broadcast transform keeps writing into
    // — frames pile up in the IdentityTransform queue until
    // `AudioRecognition.close()` runs, leaking ~16-32 KB/s.
    writer.closed
      .catch(() => {
        // closed/errored — fall through to the prune below
      })
      .finally(() => {
        const idx = this.subscriberWriters.indexOf(writer);
        if (idx >= 0) this.subscriberWriters.splice(idx, 1);
      });
    return transform.readable;
  }

  clearUserTurn() {
    this.audioTranscript = '';
    this.audioInterimTranscript = '';
    this.audioPreflightTranscript = '';
    this.finalTranscriptConfidence = [];
    this.lastFinalTranscriptTime = 0;
    this.speechStartTime = undefined;
    this.userTurnStart = undefined;
    this.lastSpeakingTime = undefined;
    this.vadSpeechStarted = false;
    this.speaking = false;
    this.userTurnCommitted = false;
    this.userTurnTracker = { words: 0, transcript: '' };
    // New turn → allow the next window's prediction to emit.
    this.lastEmittedEotPrediction = undefined;

    // Any in-flight request on the audio stream belongs to the turn we
    // just cleared — flush it so the next predict starts fresh.
    if (this.turnDetectorStream !== undefined) {
      this.turnDetectorStream.flush('clear_user_turn');
      this.turnDetectorPredictionFut = undefined;
      this.turnDetectorFlushed = true;
    }

    this._endUserTurnSpan();

    const restartStt = async () => {
      const unlock = await this.sttLifecycleLock.lock();
      try {
        if (!this.stt || this.sttOwnershipTransferred) {
          return;
        }

        await this.stopSttTasks();
        await this.sttPipeline?.close();
        this.sttPipeline = undefined;

        if (this.sttOwnershipTransferred) {
          return;
        }

        this.startSttTasks();
      } finally {
        unlock();
      }
    };

    void restartStt().catch((err) => {
      this.logger.error(`Error resetting STT task: ${err}`);
    });
  }

  /**
   * Reset the VAD by restarting its task. This is needed when STT sends a premature
   * end-of-turn signal while the user is still speaking, so VAD can detect new speech
   * and trigger interruptions correctly.
   */
  private resetVad() {
    if (!this.vad) return;

    this.vadTask?.cancelAndWait().finally(() => {
      if (this.closed) return;
      this.vadTask = Task.from(({ signal }) => this.createVadTask(this.vad, signal));
      this.vadTask.result.catch((err) => {
        this.logger.error(`Error running VAD task: ${err}`);
      });
    });
  }

  commitUserTurn(audioDetached: boolean) {
    const commitUserTurnTask =
      (delayDuration: number = 500) =>
      async (controller: AbortController) => {
        if (Date.now() - this.lastFinalTranscriptTime > delayDuration) {
          // flush the stt by pushing silence
          if (audioDetached && this.sampleRate !== undefined) {
            const silenceFrame = createSilenceFrame(delayDuration, this.sampleRate);
            this.silenceAudioWriter.write(silenceFrame);
          }

          // wait for the final transcript to be available
          await delay(delayDuration, { signal: controller.signal });
        }

        if (this.audioInterimTranscript) {
          // append interim transcript in case the final transcript is not ready
          this.audioTranscript = `${this.audioTranscript} ${this.audioInterimTranscript}`.trim();
        }
        this.audioInterimTranscript = '';

        const chatCtx = this.hooks.retrieveChatCtx();
        this.logger.debug('running EOU detection on commitUserTurn');
        this.runEOUDetection(chatCtx, 'manual');
        this.userTurnCommitted = true;
      };

    // cancel any existing commit user turn task
    this.commitUserTurnTask?.cancel();
    this.commitUserTurnTask = Task.from(commitUserTurnTask());

    this.commitUserTurnTask.result
      .then(() => {
        this.logger.debug('User turn committed');
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          this.logger.debug('User turn commit task cancelled');
          return;
        }
        this.logger.error(err, 'Error in user turn commit task:');
      });
  }

  async close() {
    this.closed = true;
    this.detachInputAudioStream();
    this.silenceAudioWriter.releaseLock();
    await this.commitUserTurnTask?.cancelAndWait();
    await this.stopSttTasks();

    if (this.sttPipeline) {
      await this.sttPipeline.close();
      this.sttPipeline = undefined;
    }

    // Close any outstanding broadcast subscribers so their consumers see EOF
    // and don't keep the IdentityTransform queues pinned in memory.
    for (const writer of this.subscriberWriters) {
      try {
        await writer.close();
      } catch {
        // already closed / aborted
      }
    }
    this.subscriberWriters = [];

    await this.vadTask?.cancelAndWait();
    await this.bounceEOUTask?.cancelAndWait();
    await this.interruptionTask?.cancelAndWait();

    if (this.turnDetectorStream !== undefined) {
      const stream = this.turnDetectorStream;
      this.turnDetectorStream = undefined;
      await stream.aclose().catch(() => undefined);
    }

    await this.interruptionStreamChannel?.close();
    this.cancelBackchannelBoundary();

    // A speech segment may never produce a transcript or committed turn. End
    // its span after all recognition tasks stop so it is still exported.
    this._endUserTurnSpan();
  }

  private _endUserTurnSpan(info?: {
    transcript: string;
    confidence: number;
    transcriptionDelay: number;
    endOfUtteranceDelay: number;
  }): void {
    if (this.userTurnSpan && info) {
      this.userTurnSpan.setAttributes({
        [traceTypes.ATTR_USER_TRANSCRIPT]: info.transcript,
        [traceTypes.ATTR_TRANSCRIPT_CONFIDENCE]: info.confidence,
        [traceTypes.ATTR_TRANSCRIPTION_DELAY]: info.transcriptionDelay,
        [traceTypes.ATTR_END_OF_TURN_DELAY]: info.endOfUtteranceDelay,
      });
      if (this.sttRequestIds.length) {
        this.userTurnSpan.setAttribute(traceTypes.ATTR_PROVIDER_REQUEST_IDS, this.sttRequestIds);
      }
    }
    if (this.userTurnSpan?.isRecording()) {
      this.userTurnSpan.end();
    }
    this.userTurnSpan = undefined;
    this.userTurnStart = undefined;
    this.sttRequestIds = [];
  }

  private get vadBaseTurnDetection() {
    if (typeof this.turnDetectionMode === 'object') {
      return false;
    }

    if (this.turnDetectionMode === undefined || this.turnDetectionMode === 'vad') {
      return true;
    }

    return false;
  }
}
