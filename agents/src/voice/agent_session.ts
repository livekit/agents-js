// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JsonObject, Struct } from '@bufbuild/protobuf';
import { Mutex } from '@livekit/mutex';
import { AgentSession as pb } from '@livekit/protocol';
import type { AudioFrame, Room } from '@livekit/rtc-node';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import type { Context, Span } from '@opentelemetry/api';
import { context as otelContext, trace } from '@opentelemetry/api';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import type { z } from 'zod';
import type { BaseStreamingTurnDetector } from '../inference/eot/base.js';
import {
  LLM as InferenceLLM,
  STT as InferenceSTT,
  TTS as InferenceTTS,
  TurnDetector as InferenceTurnDetector,
  VAD as InferenceVAD,
  type LLMModels,
  type STTModelString,
  type TTSModelString,
} from '../inference/index.js';
import type { OverlappingSpeechEvent } from '../inference/interruption/types.js';
import { getJobContext } from '../job.js';
import type { FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import {
  AgentHandoffItem,
  ChatContext,
  ChatMessage,
  type Instructions,
} from '../llm/chat_context.js';
import type {
  LLM,
  RealtimeModel,
  RealtimeModelError,
  ToolChoice,
  ToolContextEntry,
  ToolContextLike,
} from '../llm/index.js';
import { ToolContext, toToolContext } from '../llm/index.js';
import type { LLMError } from '../llm/llm.js';
import { log } from '../log.js';
import { type ModelUsage, ModelUsageCollector, filterZeroValues } from '../metrics/model_usage.js';
import type { STT } from '../stt/index.js';
import type { STTError } from '../stt/stt.js';
import { traceTypes, tracer } from '../telemetry/index.js';
import type { TTS, TTSError } from '../tts/tts.js';
import {
  DEFAULT_API_CONNECT_OPTIONS,
  DEFAULT_SESSION_CONNECT_OPTIONS,
  type ResolvedSessionConnectOptions,
  type SessionConnectOptions,
} from '../types.js';
import { Event, Task, asError } from '../utils.js';
import type { VAD } from '../vad.js';
import type { Agent } from './agent.js';
import {
  AgentActivity,
  type ReusableResources,
  cleanupReusableResources,
  isSchedulingPausedError,
} from './agent_activity.js';
import type { AMD, AMDPredictionEvent } from './amd.js';
import type { _TurnDetector } from './audio_recognition.js';
import { AgentsConsole } from './console_io.js';
import {
  type AgentEvent,
  type AgentFalseInterruptionEvent,
  AgentSessionEventTypes,
  type AgentState,
  type AgentStateChangedEvent,
  type CloseEvent,
  CloseReason,
  type ConversationItemAddedEvent,
  type EotPredictionEvent,
  type ErrorEvent,
  type FunctionToolsExecutedEvent,
  type MetricsCollectedEvent,
  type SessionUsageUpdatedEvent,
  type ShutdownReason,
  type SpeechCreatedEvent,
  type UserInputTranscribedEvent,
  type UserState,
  type UserStateChangedEvent,
  createAgentStateChangedEvent,
  createCloseEvent,
  createConversationItemAddedEvent,
  createUserStateChangedEvent,
} from './events.js';
import { AgentInput, AgentOutput } from './io.js';
import {
  KeytermDetector,
  type KeytermsOptions,
  type ResolvedSTTContextOptions,
  type STTContextOptions,
} from './keyterm_detection.js';
import { RecorderIO } from './recorder_io/index.js';
import { RoomSessionTransport, SessionHost } from './remote_session.js';
import { RoomIO, type RoomInputOptions, type RoomOutputOptions } from './room_io/index.js';
import type { UnknownUserData } from './run_context.js';
import type { SpeechHandle } from './speech_handle.js';
import { type RunOutputOptions, RunResult } from './testing/run_result.js';
import {
  type AsyncToolOptions,
  type ToolHandlingOptions,
  resolveAsyncToolOptions,
} from './tool_executor.js';
import type { TextTransform } from './transcription/text_transforms.js';
import type { EndpointingOptions } from './turn_config/endpointing.js';
import type { InterruptionOptions } from './turn_config/interruption.js';
import type {
  InternalTurnHandlingOptions,
  TurnHandlingOptions,
} from './turn_config/turn_handling.js';
import { migrateLegacyOptions, stripUndefined } from './turn_config/utils.js';
import { setParticipantSpanAttributes } from './utils.js';

export interface AgentSessionUsage {
  /** List of usage summaries, one per model/provider combination. */
  modelUsage: Array<Partial<ModelUsage>>;
}

/**
 * Granular control over which recording features are active.
 *
 * All keys default to `true` when omitted, so `{ logs: false }` means "record
 * everything except logs". Pass to {@link AgentSession.start} as `record`:
 *
 * - `record: true` — all on (backward compatible)
 * - `record: false` — all off (backward compatible)
 * - `record: { audio: true, traces: false }` — granular
 */
export interface RecordingOptions {
  /** Record session audio. Defaults to `true`. */
  audio?: boolean;
  /** Export OpenTelemetry trace spans. Defaults to `true`. */
  traces?: boolean;
  /** Export OpenTelemetry logs. Defaults to `true`. */
  logs?: boolean;
  /** Upload the conversation transcript (chat history). Defaults to `true`. */
  transcript?: boolean;
}

/** @internal Recording options with every category resolved to a boolean. */
export type ResolvedRecordingOptions = Required<RecordingOptions>;

const RECORDING_ALL_ON: ResolvedRecordingOptions = {
  audio: true,
  traces: true,
  logs: true,
  transcript: true,
};

const RECORDING_ALL_OFF: ResolvedRecordingOptions = {
  audio: false,
  traces: false,
  logs: false,
  transcript: false,
};

const idleHoldStorage = new AsyncLocalStorage<boolean>();

/**
 * Resolve a `record` argument into explicit per-category flags. A boolean turns
 * every category on or off; a partial object is merged onto all-on so omitted
 * keys default to `true`.
 *
 * @internal
 */
export function resolveRecordingOptions(
  record: boolean | RecordingOptions,
): ResolvedRecordingOptions {
  if (typeof record === 'boolean') {
    return { ...(record ? RECORDING_ALL_ON : RECORDING_ALL_OFF) };
  }
  return { ...RECORDING_ALL_ON, ...record };
}

export interface InternalSessionOptions<UserData> extends AgentSessionOptions<UserData> {
  turnHandling: InternalTurnHandlingOptions;
  sttContextOptions: ResolvedSTTContextOptions;
  useTtsAlignedTranscript: boolean;
  maxToolSteps: number;
  userAwayTimeout: number | null;
  ttsReadIdleTimeout: number;
  forwardAudioIdleTimeout: number;
  ttsTextTransforms: readonly TextTransform[] | null;
}

export const defaultAgentSessionOptions = {
  maxToolSteps: 3,
  userAwayTimeout: 15.0,
  aecWarmupDuration: 3000,
  ttsReadIdleTimeout: 10_000,
  forwardAudioIdleTimeout: 10_000,
  turnHandling: {},
  useTtsAlignedTranscript: true,
  ttsTextTransforms: ['filter_markdown', 'filter_emoji'],
} as const satisfies AgentSessionOptions;

/** @deprecated {@link VoiceOptions} has been flattened onto to {@link AgentSessionOptions} */
export type VoiceOptions = {
  maxToolSteps: number;
  /** @deprecated Use {@link AgentSessionOptions.turnHandling}.preemptiveGeneration instead. */
  preemptiveGeneration?: boolean;
  userAwayTimeout?: number | null;
  /** @deprecated Use {@link AgentSessionOptions.turnHandling}.interruption.mode instead. */
  allowInterruptions?: boolean;
  /** @deprecated Use {@link AgentSessionOptions.turnHandling}.interruption.discardAudioIfUninterruptible instead. */
  discardAudioIfUninterruptible?: boolean;
  /** @deprecated Use {@link AgentSessionOptions.turnHandling}.interruption.minDuration instead. */
  minInterruptionDuration?: number;
  /** @deprecated Use {@link AgentSessionOptions.turnHandling}.interruption.minWords instead. */
  minInterruptionWords?: number;
  /** @deprecated Use {@link AgentSessionOptions.turnHandling}.endpointing.minDelay instead. */
  minEndpointingDelay?: number;
  /** @deprecated Use {@link AgentSessionOptions.turnHandling}.endpointing.maxDelay instead. */
  maxEndpointingDelay?: number;
};

export type TurnDetectionMode =
  | 'stt'
  | 'vad'
  | 'realtime_llm'
  | 'manual'
  | _TurnDetector
  | BaseStreamingTurnDetector;

export type AgentSessionCallbacks = {
  [AgentSessionEventTypes.UserInputTranscribed]: (ev: UserInputTranscribedEvent) => void;
  [AgentSessionEventTypes.AgentStateChanged]: (ev: AgentStateChangedEvent) => void;
  [AgentSessionEventTypes.UserStateChanged]: (ev: UserStateChangedEvent) => void;
  [AgentSessionEventTypes.ConversationItemAdded]: (ev: ConversationItemAddedEvent) => void;
  [AgentSessionEventTypes.FunctionToolsExecuted]: (ev: FunctionToolsExecutedEvent) => void;
  [AgentSessionEventTypes.MetricsCollected]: (ev: MetricsCollectedEvent) => void;
  [AgentSessionEventTypes.SessionUsageUpdated]: (ev: SessionUsageUpdatedEvent) => void;
  [AgentSessionEventTypes.DebugMessage]: (ev: pb.DebugMessage) => void;
  [AgentSessionEventTypes.SpeechCreated]: (ev: SpeechCreatedEvent) => void;
  [AgentSessionEventTypes.AgentFalseInterruption]: (ev: AgentFalseInterruptionEvent) => void;
  [AgentSessionEventTypes.Error]: (ev: ErrorEvent) => void;
  [AgentSessionEventTypes.Close]: (ev: CloseEvent) => void;
  [AgentSessionEventTypes.OverlappingSpeech]: (ev: OverlappingSpeechEvent) => void;
  [AgentSessionEventTypes.EotPrediction]: (ev: EotPredictionEvent) => void;
};

export type AgentSessionOptions<UserData = UnknownUserData> = {
  stt?: STT | STTModelString;
  /**
   * Voice Activity Detection. When omitted, `AgentSession` auto-provisions a
   * bundled `inference.VAD({ model: 'silero' })` and marks it as the default
   * (so sites that check whether the user supplied a VAD treat the bundled
   * one as absent). Pass `null` to opt out entirely.
   */
  vad?: VAD | null;
  llm?: LLM | RealtimeModel | LLMModels;
  tts?: TTS | TTSModelString;
  userData?: UserData;
  connOptions?: SessionConnectOptions;
  tools?: ToolContextLike<UserData>;
  toolHandling?: ToolHandlingOptions;

  /** @deprecated use turnHandling.turnDetection instead */
  turnDetection?: TurnDetectionMode;
  /** @deprecated use top-level SessionOptions fields instead */
  voiceOptions?: Partial<VoiceOptions>;

  maxToolSteps?: number;
  /**
   * @deprecated Use `turnHandling.preemptiveGeneration` instead.
   * When set, migrated into `turnHandling.preemptiveGeneration.enabled`.
   */
  preemptiveGeneration?: boolean;

  /**
   * If set, set the user state as "away" after this amount of time after user and agent are
   * silent. Set to `null` to disable.
   * @defaultValue 15.0
   */
  userAwayTimeout?: number | null;

  /**
   * Duration in milliseconds for AEC (Acoustic Echo Cancellation) warmup, during which
   * interruptions from audio activity are suppressed. Set to `null` to disable.
   * @defaultValue 3000
   */
  aecWarmupDuration?: number | null;

  /**
   * Maximum time in milliseconds to wait for the next frame on the TTS audio stream
   * inside `performTTSInference`. Applies to every read, including the first.
   * If exceeded, the TTS stream is forcibly closed and a stall warning is logged.
   * @defaultValue 10000
   */
  ttsReadIdleTimeout?: number;

  /**
   * Maximum time in milliseconds to wait for the next frame while forwarding TTS
   * audio to the audio output inside `performAudioForwarding`. Applies to every read,
   * including the first. If exceeded, forwarding is forcibly closed and a stall
   * warning is logged.
   * @defaultValue 10000
   */
  forwardAudioIdleTimeout?: number;

  /**
   * Configuration for turn handling.
   */
  turnHandling?: Partial<TurnHandlingOptions>;

  /**
   * Conversation-aware context for the STT: static `keyterms` plus `keytermDetection` for STTs
   * that accept a term list, and `forwardChatContext` (on by default) that forwards conversation
   * turns to STTs that consume context directly. Applied where the STT supports it, ignored
   * otherwise.
   */
  sttContextOptions?: STTContextOptions;

  /**
   * @deprecated Use `sttContextOptions` instead. Its `keyterms`/`keytermDetection` keys map onto
   * the new option.
   */
  keytermsOptions?: KeytermsOptions;

  useTtsAlignedTranscript?: boolean;

  /**
   * Transforms to apply to TTS input text. Built-in transforms are `filter_markdown`
   * and `filter_emoji`; pass `null` to disable text transforms.
   */
  ttsTextTransforms?: readonly TextTransform[] | null;
};

export type AgentSessionUpdateOptions = {
  /** Configuration updates for turn handling. */
  turnHandling?: {
    /**
     * Strategy for deciding when the user has finished speaking.
     *
     * - `undefined`: leave the current turn detection setting unchanged.
     * - `null`: clear the current turn detection setting and return to automatic selection.
     * - `TurnDetectionMode`: set the turn detection strategy to the provided value.
     */
    turnDetection?: TurnDetectionMode | null;
    /** Endpointing options to merge into the current session defaults. */
    endpointing?: Partial<EndpointingOptions>;
  };
  /**
   * @deprecated use turnHandling.turnDetection instead.
   *
   * - `undefined`: leave the current turn detection setting unchanged.
   * - `null`: clear the current turn detection setting and return to automatic selection.
   * - `TurnDetectionMode`: set the turn detection strategy to the provided value.
   */
  turnDetection?: TurnDetectionMode | null;

  /**
   * Replace the user-defined keyterms applied to the STT. Auto-detected keyterms
   * are left untouched.
   */
  keyterms?: string[];
};

type ActivityTransitionOptions = {
  previousActivity?: 'close' | 'pause';
  newActivity?: 'start' | 'resume';
  blockedTasks?: Task<any>[];
  waitOnEnter?: boolean;
};

export class AgentSession<
  UserData = UnknownUserData,
> extends (EventEmitter as new () => TypedEmitter<AgentSessionCallbacks>) {
  vad?: VAD;
  stt?: STT;
  llm?: LLM | RealtimeModel;
  tts?: TTS;
  turnDetection?: TurnDetectionMode;

  /** @deprecated use {@link sessionOptions } instead */
  readonly options: VoiceOptions;

  readonly sessionOptions: InternalSessionOptions<UserData>;

  private readonly activityLock = new Mutex();

  private agent?: Agent;
  private activity?: AgentActivity;
  private nextActivity?: AgentActivity;
  private updateActivityTask?: Task<void>;
  private started = false;
  private sessionHost?: SessionHost;

  private _chatCtx: ChatContext;
  private _userData: UserData | undefined;
  private _toolCtx: ToolContext<UserData>;
  private _userState: UserState = 'listening';
  private _agentState: AgentState = 'initializing';

  private _input: AgentInput;
  private _output: AgentOutput;

  private closing = false;
  private closingTask: Promise<void> | null = null;
  private userAwayTimer: NodeJS.Timeout | null = null;
  private idleHolds = 0;
  private idleReleased = new Event();

  private _aecWarmupTimer: NodeJS.Timeout | null = null;

  // Connection options for STT, LLM, and TTS
  private _connOptions: ResolvedSessionConnectOptions;

  // Unrecoverable error counts, reset after agent speaking
  private llmErrorCounts = 0;
  private ttsErrorCounts = 0;

  private sessionSpan?: Span;
  private agentSpeakingSpan?: Span;

  private _interruptionDetection?: InterruptionOptions['mode'];

  /**
   * True iff this session auto-provisioned the bundled silero VAD because the
   * caller passed no `vad=`. Set once in the constructor; immutable from then
   * on. Read it via `AgentActivity.usingDefaultVad` from voice-pipeline code.
   *
   * @internal
   */
  _usingDefaultVad: boolean = false;

  /** @internal */
  _usageCollector: ModelUsageCollector = new ModelUsageCollector();

  /** @internal */
  readonly _keytermDetector: KeytermDetector;

  /** @internal */
  _roomIO?: RoomIO;

  /**
   * Currently active AMD instance, if one was constructed against this session.
   * Mirrors python `AgentSession._amd`. Useful for tests, telemetry, and
   * higher-level helpers that need to introspect classification state.
   */
  private _amd: AMD | null = null;

  /** @internal */
  _aecWarmupRemaining = 0;

  /** @internal */
  _recorderIO?: RecorderIO;

  /** @internal */
  rootSpanContext?: Context;

  /** @internal */
  _recordedEvents: AgentEvent[] = [];

  /** @internal Resolved per-category recording options for this session. */
  _recordingOptions: ResolvedRecordingOptions = { ...RECORDING_ALL_OFF };

  /** @internal */
  _asyncToolOptions: AsyncToolOptions = resolveAsyncToolOptions();

  /** @internal */
  _sessionToolsetsSetup = false;

  /** @internal True when any recording category is enabled. */
  get _enableRecording(): boolean {
    return (
      this._recordingOptions.audio ||
      this._recordingOptions.traces ||
      this._recordingOptions.logs ||
      this._recordingOptions.transcript
    );
  }

  /** @internal - Timestamp when the session started (milliseconds) */
  _startedAt?: number;

  /** @internal - Whether `start()` has been called and completed. */
  get _started(): boolean {
    return this.started;
  }

  /** @internal - Whether the session is closing/draining. */
  get _closing(): boolean {
    return this.closing;
  }

  /** @internal - Current run state for testing */
  _globalRunState?: RunResult;

  /** @internal */
  _userSpeakingSpan?: Span;

  private logger = log();

  constructor(options: AgentSessionOptions<UserData> = {}) {
    super();

    const { agentSessionOptions: opts, legacyVoiceOptions } =
      migrateLegacyOptions<UserData>(options);

    const {
      vad,
      stt,
      llm,
      tts,
      userData,
      connOptions,
      tools,
      toolHandling,
      ...resolvedSessionOptions
    } = opts;
    // Merge user-provided connOptions with defaults
    this._connOptions = {
      sttConnOptions: { ...DEFAULT_API_CONNECT_OPTIONS, ...connOptions?.sttConnOptions },
      llmConnOptions: { ...DEFAULT_API_CONNECT_OPTIONS, ...connOptions?.llmConnOptions },
      ttsConnOptions: { ...DEFAULT_API_CONNECT_OPTIONS, ...connOptions?.ttsConnOptions },
      maxUnrecoverableErrors:
        connOptions?.maxUnrecoverableErrors ??
        DEFAULT_SESSION_CONNECT_OPTIONS.maxUnrecoverableErrors,
    };

    // VAD: undefined → auto-provision bundled inference.VAD (silero). The
    // `_usingDefaultVad` marker is the single source of truth for "this VAD
    // was framework-provisioned" — code paths that should ignore a default
    // VAD read it via `AgentActivity.usingDefaultVad`. null → leave VAD off
    // entirely. Otherwise use what the caller supplied.
    this._usingDefaultVad = vad === undefined;
    if (vad === undefined) {
      this.vad = new InferenceVAD({ model: 'silero' });
    } else if (vad === null) {
      this.vad = undefined;
    } else {
      this.vad = vad;
    }

    if (typeof stt === 'string') {
      this.stt = InferenceSTT.fromModelString(stt);
    } else {
      this.stt = stt;
    }

    if (typeof llm === 'string') {
      this.llm = InferenceLLM.fromModelString(llm);
    } else {
      this.llm = llm;
    }

    if (typeof tts === 'string') {
      this.tts = InferenceTTS.fromModelString(tts);
    } else {
      this.tts = tts;
    }

    // Default turn_detection: when the caller didn't pin a mode or supply a
    // detector instance (`undefined`/not-given), fall back to a fresh
    // inference.TurnDetector so every session ships with audio EOT
    // out of the box. An explicit `null` opts out entirely — no detector is
    // built.
    const configuredTurnDetection = resolvedSessionOptions.turnHandling.turnDetection;
    this.turnDetection =
      configuredTurnDetection === null
        ? undefined
        : configuredTurnDetection ?? new InferenceTurnDetector();
    this._interruptionDetection = resolvedSessionOptions.turnHandling.interruption?.mode;
    this._userData = userData;
    this._toolCtx = toToolContext(tools) ?? ToolContext.empty<UserData>();
    this._asyncToolOptions = resolveAsyncToolOptions(toolHandling?.asyncOptions);

    // configurable IO
    this._input = new AgentInput(this.onAudioInputChanged);
    this._output = new AgentOutput(this.onAudioOutputChanged, this.onTextOutputChanged);

    // This is the "global" chat context, it holds the entire conversation history
    this._chatCtx = ChatContext.empty();
    this.sessionOptions = resolvedSessionOptions;

    this._keytermDetector = new KeytermDetector({
      staticKeyterms: this.sessionOptions.sttContextOptions.keyterms,
      options: this.sessionOptions.sttContextOptions.keytermDetection,
    });

    this.options = legacyVoiceOptions;
    this._aecWarmupRemaining = this.sessionOptions.aecWarmupDuration ?? 0;

    this._onUserInputTranscribed = this._onUserInputTranscribed.bind(this);
    this.on(AgentSessionEventTypes.UserInputTranscribed, this._onUserInputTranscribed);
    this.idleReleased.set();
  }

  emit<K extends keyof AgentSessionCallbacks>(
    event: K,
    ...args: Parameters<AgentSessionCallbacks[K]>
  ): boolean {
    // Only retain events when recording is actually enabled. Otherwise this
    // array grows unbounded for the entire (potentially hours-long) session,
    // pinning every event's graph (SpeechHandle, OTel spans/contexts, streams)
    // and leaking memory even though the events are never reported. The buffer
    // is only consumed by makeSessionReport() when recording is enabled.
    if (this._enableRecording) {
      const eventData = args[0] as AgentEvent;
      this._recordedEvents.push(eventData);
    }
    return super.emit(event, ...args);
  }

  get input(): AgentInput {
    return this._input;
  }

  get output(): AgentOutput {
    return this._output;
  }

  get userData(): UserData {
    if (this._userData === undefined) {
      throw new Error('Voice agent userData is not set');
    }

    return this._userData;
  }

  get history(): ChatContext {
    return this._chatCtx;
  }

  /** The effective keyterms (user-defined + auto-detected) currently applied to the STT. */
  get keyterms(): string[] {
    return this._keytermDetector.keyterms;
  }

  /** Connection options for STT, LLM, and TTS. */
  get connOptions(): ResolvedSessionConnectOptions {
    return this._connOptions;
  }

  get interruptionDetection() {
    return this._interruptionDetection;
  }

  /**
   * Returns usage summaries for this session, one per model/provider combination.
   */
  get usage(): AgentSessionUsage {
    // Skip zero fields for more concise usage display (matches python behavior).
    return { modelUsage: this._usageCollector.flatten().map(filterZeroValues) };
  }

  get useTtsAlignedTranscript(): boolean {
    return this.sessionOptions.useTtsAlignedTranscript;
  }

  set userData(value: UserData) {
    this._userData = value;
  }

  private async _startImpl({
    agent,
    room,
    inputOptions,
    outputOptions,
    span,
  }: {
    agent: Agent;
    room?: Room;
    inputOptions?: Partial<RoomInputOptions>;
    outputOptions?: Partial<RoomOutputOptions>;
    span: Span;
  }): Promise<void> {
    span.setAttribute(traceTypes.ATTR_AGENT_LABEL, agent.id);

    this.agent = agent;
    this._updateAgentState('initializing');

    const tasks: Promise<void>[] = [];

    const consoleInst = AgentsConsole.getInstance();
    if (consoleInst.enabled && !consoleInst.ioAcquired) {
      if (this.input.audio || this.output.audio) {
        this.logger.warn(
          'agent started with the console subcommand, but input.audio/output.audio is already set, overriding...',
        );
      }

      consoleInst.acquireIo(this);

      if (consoleInst.transport) {
        this.sessionHost = new SessionHost(
          consoleInst.transport,
          consoleInst.audioInput,
          consoleInst.audioOutput,
        );
        this.sessionHost.registerSession(this);
      }
    } else if (room && !this._roomIO) {
      // Check for existing input/output configuration and warn if needed
      if (this.input.audio && inputOptions?.audioEnabled !== false) {
        this.logger.warn(
          'RoomIO audio input is enabled but input.audio is already set, ignoring..',
        );
      }

      if (this.output.audio && outputOptions?.audioEnabled !== false) {
        this.logger.warn(
          'RoomIO audio output is enabled but output.audio is already set, ignoring..',
        );
      }

      if (this.output.transcription && outputOptions?.transcriptionEnabled !== false) {
        this.logger.warn(
          'RoomIO transcription output is enabled but output.transcription is already set, ignoring..',
        );
      }

      this._roomIO = new RoomIO({
        agentSession: this,
        room,
        inputOptions,
        outputOptions,
      });

      this._roomIO.start();

      const transport = new RoomSessionTransport(room, this._roomIO);
      this.sessionHost = new SessionHost(transport);
      this.sessionHost.registerSession(this);
    }

    const ctx = getJobContext(false);

    if (ctx) {
      if (room && ctx.room === room && !room.isConnected) {
        this.logger.debug('Auto-connecting to room via job context');
        tasks.push(ctx.connect());
      }

      // `lk console --record` forces audio recording even if the session was
      // started with `record: false`.
      const consoleForcesRecord = consoleInst.enabled && consoleInst.record;
      if (
        this.input.audio &&
        this.output.audio &&
        (this._recordingOptions.audio || consoleForcesRecord)
      ) {
        this._recorderIO = new RecorderIO({ agentSession: this });
        this.input.audio = this._recorderIO.recordInput(this.input.audio);
        this.output.audio = this._recorderIO.recordOutput(this.output.audio);

        // Start recording to the session directory. In console mode the disk
        // write is gated on --record.
        if (consoleForcesRecord || !consoleInst.enabled) {
          const sessionDir = ctx.sessionDirectory;
          if (sessionDir) {
            tasks.push(this._recorderIO.start(`${sessionDir}/audio.ogg`));
          }
        }
      }
    }

    // TODO(AJS-265): add shutdown callback to job context
    // Initial start does not wait on onEnter
    tasks.push(this._updateActivity(this.agent, { waitOnEnter: false }));

    await ThrowsPromise.allSettled(tasks);

    if (this.sessionHost) {
      await this.sessionHost.start();
    }

    // Log used IO configuration
    this.logger.debug(
      `using audio io: ${this.input.audio ? '`' + this.input.audio.constructor.name + '`' : '(none)'} -> \`AgentSession\` -> ${this.output.audio ? '`' + this.output.audio.constructor.name + '`' : '(none)'}`,
    );

    if (
      this.sessionOptions.turnHandling.interruption.resumeFalseInterruption &&
      this.output.audio &&
      !this.output.audio.canPause
    ) {
      this.logger.warn(
        {
          audioOutput: this.output.audio.constructor.name,
        },
        'resumeFalseInterruption is enabled but audio output does not support pause, it will be ignored',
      );
    }

    this.logger.debug(
      `using transcript io: \`AgentSession\` -> ${this.output.transcription ? '`' + this.output.transcription.constructor.name + '`' : '(none)'}`,
    );

    this.started = true;
    this._startedAt = Date.now();
    this._updateAgentState('listening');
  }

  async start({
    agent,
    room,
    inputOptions,
    outputOptions,
    record,
  }: {
    agent: Agent;
    room?: Room;
    inputOptions?: Partial<RoomInputOptions>;
    outputOptions?: Partial<RoomOutputOptions>;
    record?: boolean | RecordingOptions;
  }): Promise<void> {
    if (this.started) {
      return;
    }

    this.closing = false;
    this._usageCollector = new ModelUsageCollector();

    const ctx = getJobContext(false);

    if (ctx) {
      const recordIsGiven = record !== undefined;
      if (record === undefined) {
        // defer to the server-side setting for recording
        record = ctx.job.enableRecording;
      }

      this._recordingOptions = resolveRecordingOptions(record);

      // Only one AgentSession per job can be the primary (and therefore record).
      // Designate the primary before initRecording so a demoted secondary session
      // never configures cloud recording. Mirrors Python's start() ordering.
      if (ctx._primaryAgentSession === undefined || ctx._primaryAgentSession === this) {
        ctx._primaryAgentSession = this;
      } else if (this._enableRecording) {
        if (recordIsGiven) {
          throw new Error(
            'Only one `AgentSession` can be the primary at a time. If you want to ignore primary designation, use `session.start({ record: false })`.',
          );
        }
        // record was not given: silently disable recording for the secondary session
        this._recordingOptions = resolveRecordingOptions(false);
      }

      if (this._enableRecording) {
        await ctx.initRecording(this._recordingOptions);
      }
    }

    this.sessionSpan = tracer.startSpan({
      name: 'agent_session',
    });

    this.rootSpanContext = trace.setSpan(otelContext.active(), this.sessionSpan);

    await this._startImpl({
      agent,
      room,
      inputOptions,
      outputOptions,
      span: this.sessionSpan,
    });
  }

  updateAgent(agent: Agent): void {
    this.agent = agent;

    if (!this.started) {
      return;
    }

    // immediately block the old activity from accepting new user turns
    // during the transition window (before drain() formally pauses scheduling)
    this.activity?.blockNewTurns();

    const _updateActivityTask = async (oldTask: Task<void> | undefined, agent: Agent) => {
      if (oldTask) {
        try {
          await oldTask.result;
        } catch (error) {
          this.logger.error(error, 'previous updateAgent transition failed');
        }
      }

      await this._updateActivity(agent);
    };

    const oldTask = this.updateActivityTask;
    this.updateActivityTask = Task.from(
      async () => _updateActivityTask(oldTask, agent),
      undefined,
      'AgentSession_updateActivityTask',
    );

    const runState = this._globalRunState;
    if (runState) {
      // Don't mark the RunResult as done, if there is currently an agent transition happening.
      // (used to make sure we're correctly adding the AgentHandoffResult before completion)
      runState._watchHandle(this.updateActivityTask);
    }
  }

  commitUserTurn() {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }

    this.activity.commitUserTurn();
  }

  clearUserTurn() {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }
    this.activity.clearUserTurn();
  }

  say(
    text: string | ReadableStream<string>,
    options?: {
      audio?: ReadableStream<AudioFrame>;
      allowInterruptions?: boolean;
      addToChatCtx?: boolean;
    },
  ): SpeechHandle {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }

    const doSay = (activity: AgentActivity, nextActivity?: AgentActivity) => {
      if (activity.schedulingPaused) {
        if (!nextActivity) {
          throw new Error('AgentSession is closing, cannot use say()');
        }
        return nextActivity.say(text, options);
      }
      return activity.say(text, options);
    };

    const runState = this._globalRunState;
    let handle: SpeechHandle;

    // attach to the session span if called outside of the AgentSession
    const activeSpan = trace.getActiveSpan();
    if (!activeSpan && this.rootSpanContext) {
      handle = otelContext.with(this.rootSpanContext, () =>
        doSay(this.activity!, this.nextActivity),
      );
    } else {
      handle = doSay(this.activity, this.nextActivity);
    }

    if (runState) {
      runState._watchHandle(handle);
    }

    return handle;
  }

  interrupt(options?: { force?: boolean }) {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }

    return this.activity.interrupt(options);
  }

  /** @internal — emit a debug/trace payload to the debugger/recorder. */
  _emitDebugMessage(payload: JsonObject): void {
    const debugMessage = new pb.DebugMessage({ payload: Struct.fromJson(payload) });
    super.emit(AgentSessionEventTypes.DebugMessage, debugMessage);
  }

  /**
   * The currently bound `AMD` instance, or `null` if AMD is not in use.
   * Mirrors python `AgentSession.amd`.
   */
  get amd(): AMD | null {
    return this._amd;
  }

  /** @internal — used by AMD to register/unregister itself with the session. */
  _setAmd(amd: AMD | null): void {
    this._amd = amd;
  }

  /**
   * The currently running activity, or `undefined` when none is active. Mirrors
   * python `session._activity` — exposed so tightly-coupled internals (e.g. AMD)
   * can read activity state such as the endpointing delay.
   * @internal
   */
  get _activity(): AgentActivity | undefined {
    return this.activity;
  }

  /**
   * @internal — forwarded to {@link SessionHost} so a connected
   * {@link RemoteSession} peer receives an `amd_prediction` event when AMD
   * settles. Mirrors python `AgentSession._session_host._on_amd_prediction`.
   */
  _onAmdPrediction(event: AMDPredictionEvent): void {
    this.sessionHost?._onAmdPrediction(event);
  }

  /**
   * @internal — returns a tee'd branch of the active participant audio stream
   * for AMD's dedicated STT. Returns `undefined` when no `AgentActivity` is
   * running yet (the AMD STT pump retries until an activity is available).
   */
  _subscribeAudioStream(): ReadableStream<AudioFrame> | undefined {
    return this.activity?.subscribeAudioStream();
  }

  pauseReplyAuthorization(): void {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }

    this.activity.pauseReplyAuthorization();
  }

  resumeReplyAuthorization(): void {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }

    this.activity.resumeReplyAuthorization();
  }

  updateOptions(options: AgentSessionUpdateOptions): void {
    if (options.keyterms !== undefined) {
      this._keytermDetector.setStaticKeyterms(options.keyterms);
    }

    const endpointing = options.turnHandling?.endpointing;
    const turnDetection =
      options.turnHandling?.turnDetection !== undefined
        ? options.turnHandling.turnDetection
        : options.turnDetection;
    const hasTurnDetection = turnDetection !== undefined;
    const normalizedTurnDetection = turnDetection ?? undefined;

    if (endpointing !== undefined) {
      const stripped = stripUndefined(endpointing);
      this.sessionOptions.turnHandling.endpointing = {
        ...this.sessionOptions.turnHandling.endpointing,
        ...stripped,
      };
      // record the explicit keys so a fresh activity (built on agent handoff)
      // re-resolves with them instead of falling back to defaults.
      this.sessionOptions.turnHandling.endpointingOverrides = {
        ...this.sessionOptions.turnHandling.endpointingOverrides,
        ...stripped,
      };
    }

    if (hasTurnDetection) {
      this.turnDetection = normalizedTurnDetection;
      this.sessionOptions.turnHandling.turnDetection = normalizedTurnDetection;
    }

    if (this.activity) {
      const activityOptions: Parameters<AgentActivity['updateOptions']>[0] = {};
      if (endpointing !== undefined) {
        activityOptions.endpointing = this.sessionOptions.turnHandling.endpointing;
      }
      if (hasTurnDetection) {
        activityOptions.turnDetection = turnDetection;
      }
      this.activity.updateOptions(activityOptions);
    }
  }

  generateReply(options?: {
    userInput?: string | ChatMessage;
    chatCtx?: ChatContext;
    instructions?: string | Instructions;
    toolChoice?: ToolChoice;
    allowInterruptions?: boolean;
    /** The input modality used for generating the reply. Defaults to `"text"`. */
    inputModality?: 'audio' | 'text';
  }): SpeechHandle {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }

    const userMessage =
      options?.userInput instanceof ChatMessage
        ? options.userInput
        : options?.userInput
          ? new ChatMessage({
              role: 'user',
              content: options.userInput,
            })
          : undefined;

    const inputDetails = { modality: options?.inputModality ?? 'text' } as const;

    const doGenerateReply = (activity: AgentActivity, nextActivity?: AgentActivity) => {
      if (activity.schedulingPaused) {
        if (!nextActivity) {
          throw new Error('AgentSession is closing, cannot use generateReply()');
        }
        return nextActivity.generateReply({ userMessage, ...options, inputDetails });
      }

      // Handoff can race with scheduling pause between the check above and generateReply().
      // If that happens, retry on the next activity instead of surfacing an avoidable error.
      try {
        return activity.generateReply({ userMessage, ...options, inputDetails });
      } catch (error) {
        const canFallback = nextActivity !== undefined && isSchedulingPausedError(error);
        if (!canFallback) {
          throw error;
        }
        this.logger.debug(
          { error },
          'generateReply scheduling raced with handoff drain; retrying on next activity',
        );
        return nextActivity.generateReply({ userMessage, ...options, inputDetails });
      }
    };

    // attach to the session span if called outside of the AgentSession
    const activeSpan = trace.getActiveSpan();
    let handle: SpeechHandle;
    if (!activeSpan && this.rootSpanContext) {
      handle = otelContext.with(this.rootSpanContext, () =>
        doGenerateReply(this.activity!, this.nextActivity),
      );
    } else {
      handle = doGenerateReply(this.activity!, this.nextActivity);
    }

    if (this._globalRunState) {
      this._globalRunState._watchHandle(handle);
    }

    return handle;
  }

  /**
   * Run a test with user input and return a result for assertions.
   *
   * This method is primarily used for testing agent behavior without
   * requiring a real room connection.
   *
   * @example
   * ```typescript
   * const result = await session.run({ userInput: 'Hello' });
   * result.expect.nextEvent().isMessage({ role: 'assistant' });
   * result.expect.noMoreEvents();
   * ```
   *
   * @param options - Run options including user input and optional output type.
   *   When `outputType` is set and the turn ends without structured output, the
   *   run re-prompts the model up to `outputOptions.maxRetries` times (default 2)
   *   before rejecting with `UnexpectedModelBehavior`. Pass `outputOptions: null`
   *   to disable retries entirely.
   * @returns A RunResult that resolves when the agent finishes responding
   */
  run<T = unknown>({
    userInput,
    inputModality,
    outputType,
    outputOptions,
  }: {
    userInput: string;
    inputModality?: 'audio' | 'text';
    outputType?: z.ZodType<T>;
    outputOptions?: RunOutputOptions | null;
  }): RunResult<T> {
    if (this._globalRunState && !this._globalRunState.done()) {
      throw new Error('nested runs are not supported');
    }

    const runState = new RunResult<T>({
      userInput,
      outputType,
      outputOptions,
      session: this,
    });

    this._globalRunState = runState;

    // Defer generateReply through the activityLock to ensure any in-progress
    // activity transition (e.g. AgentTask started from onEnter) completes first.
    // TS Task.from starts onEnter synchronously, so the transition may already be
    // mid-flight by the time run() is called after session.start() resolves.
    // Acquiring and immediately releasing the lock guarantees FIFO ordering:
    // the transition's lock section finishes before we route generateReply.
    (async () => {
      try {
        const unlock = await this.activityLock.lock();
        unlock();
        this.generateReply({ userInput, inputModality });
      } catch (e) {
        runState._reject(asError(e));
      }
    })();

    return runState;
  }

  /** @internal */
  async _updateActivity(agent: Agent, options: ActivityTransitionOptions = {}): Promise<void> {
    const { previousActivity = 'close', newActivity = 'start', blockedTasks = [] } = options;
    const waitOnEnter = options.waitOnEnter ?? newActivity === 'start';

    const runWithContext = async () => {
      const unlock = await this.activityLock.lock();
      let onEnterTask: Task<void> | undefined;
      let reusableResources: ReusableResources | undefined;

      try {
        this.agent = agent;
        const prevActivityObj = this.activity;

        if (newActivity === 'start') {
          const prevAgent = prevActivityObj?.agent;
          if (
            agent._agentActivity &&
            // allow updating the same agent that is running
            (agent !== prevAgent || previousActivity !== 'close')
          ) {
            throw new Error('Cannot start agent: an activity is already running');
          }
          this.nextActivity = new AgentActivity(agent, this);
        } else if (newActivity === 'resume') {
          if (!agent._agentActivity) {
            throw new Error('Cannot resume agent: no existing activity to resume');
          }
          this.nextActivity = agent._agentActivity;
        }

        if (prevActivityObj && prevActivityObj !== this.nextActivity) {
          if (previousActivity === 'pause') {
            reusableResources = await prevActivityObj.pause({
              blockedTasks,
              newActivity: this.nextActivity,
            });
          } else {
            reusableResources = await prevActivityObj.drain({
              newActivity: this.nextActivity,
            });
            await prevActivityObj.close();
          }
        }

        if (this.closing && newActivity === 'start') {
          this.logger.warn(
            { agentId: this.nextActivity?.agent.id },
            'Session is closing, skipping start of next activity',
          );
          if (reusableResources) {
            await cleanupReusableResources(reusableResources, this.logger);
            reusableResources = undefined;
          }
          this.nextActivity = undefined;
          this.activity = undefined;
          return;
        }

        this.activity = this.nextActivity;
        this.nextActivity = undefined;

        const runState = this._globalRunState;
        const handoffItem = new AgentHandoffItem({
          oldAgentId: prevActivityObj?.agent.id,
          newAgentId: agent.id,
        });

        if (runState) {
          runState._agentHandoff({
            item: handoffItem,
            oldAgent: prevActivityObj?.agent,
            newAgent: this.activity!.agent,
          });
        }

        this._conversationItemAdded(handoffItem);
        this.logger.debug(
          { previousAgentId: prevActivityObj?.agent.id, newAgentId: agent.id },
          'Agent handoff inserted into chat context',
        );

        if (newActivity === 'start') {
          await this.activity!.start({ reuseResources: reusableResources });
        } else {
          await this.activity!.resume({ reuseResources: reusableResources });
        }
        reusableResources = undefined;

        onEnterTask = this.activity!._onEnterTask;

        if (this._input.audio) {
          this.activity!.attachAudioInput(this._input.audio.stream);
        }
      } catch (error) {
        // JS safeguard: session cleanup owns the detached resources until the next activity
        // starts successfully, preventing leaks when handoff fails mid-transition.
        if (reusableResources) {
          await cleanupReusableResources(reusableResources, this.logger);
        }
        throw error;
      } finally {
        unlock();
      }

      if (waitOnEnter) {
        if (!onEnterTask) {
          throw new Error('expected onEnter task to be available while waitOnEnter=true');
        }
        await onEnterTask.result;
      }
    };

    // Run within session span context if available
    if (this.rootSpanContext) {
      return otelContext.with(this.rootSpanContext, runWithContext);
    }

    return runWithContext();
  }

  get chatCtx(): ChatContext {
    return this._chatCtx.copy();
  }

  get agentState(): AgentState {
    return this._agentState;
  }

  get userState(): UserState {
    return this._userState;
  }

  get currentAgent(): Agent {
    if (!this.agent) {
      throw new Error('AgentSession is not running');
    }

    return this.agent;
  }

  get toolCtx(): ToolContext<UserData> {
    return this._toolCtx.copy();
  }

  get tools(): readonly ToolContextEntry<UserData>[] {
    return this._toolCtx.tools;
  }

  async waitForIdle(): Promise<AgentActivity> {
    while (true) {
      if (this.closingTask) {
        throw new Error('AgentSession is closing');
      }
      const activity = this.activity;
      if (!activity) {
        throw new Error('AgentSession has no active AgentActivity');
      }
      try {
        await activity.waitForIdle();
        return activity;
      } catch (error) {
        if (this.activity === activity) {
          throw error;
        }
      }
    }
  }

  async waitForIdleAndHold<T>(fn: (activity: AgentActivity) => Promise<T> | T): Promise<T> {
    const activity = await this.waitForIdle();
    this.idleHolds += 1;
    this.idleReleased.clear();
    try {
      return await idleHoldStorage.run(true, () => fn(activity));
    } finally {
      this.idleHolds -= 1;
      if (this.idleHolds === 0) {
        this.idleReleased.set();
      }
    }
  }

  /**
   * Wait until any foreground idle-hold (`waitForIdleAndHold`) is released.
   * Returns `true` if it actually waited for a release — callers use that to
   * re-verify idleness, since work may have resumed during the hold.
   * @internal
   */
  async _waitForIdleHoldReleased(): Promise<boolean> {
    if (this.idleHolds > 0 && !idleHoldStorage.getStore()) {
      await this.idleReleased.wait();
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    await this.closeImpl(CloseReason.USER_INITIATED);
  }

  shutdown(options?: { drain?: boolean; reason?: ShutdownReason }): void {
    const { drain = true, reason = CloseReason.USER_INITIATED } = options ?? {};

    this._closeSoon({
      reason,
      drain,
    });
  }

  /** @internal */
  _closeSoon({
    reason,
    drain = false,
    error = null,
  }: {
    reason: ShutdownReason;
    drain?: boolean;
    error?: RealtimeModelError | STTError | TTSError | LLMError | null;
  }): void {
    if (this.closingTask) {
      return;
    }
    this.closingTask = this.closeImpl(reason, error, drain).finally(() => {
      this.closingTask = null;
    });
  }

  /** @internal */
  _onError(error: RealtimeModelError | STTError | TTSError | LLMError): void {
    if (this.closingTask || error.recoverable) {
      return;
    }

    // Track error counts per type to implement max_unrecoverable_errors logic
    if (error.type === 'llm_error') {
      this.llmErrorCounts += 1;
      if (this.llmErrorCounts <= this._connOptions.maxUnrecoverableErrors) {
        return;
      }
    } else if (error.type === 'tts_error') {
      this.ttsErrorCounts += 1;
      if (this.ttsErrorCounts <= this._connOptions.maxUnrecoverableErrors) {
        return;
      }
    }

    this.logger.error(error, 'AgentSession is closing due to an unrecoverable error');

    this.closingTask = (async () => {
      await this.closeImpl(CloseReason.ERROR, error);
    })().then(() => {
      this.closingTask = null;
    });
  }

  /** @internal */
  _conversationItemAdded(item: ChatMessage | AgentHandoffItem): void {
    this._chatCtx.insert(item);
    this.emit(AgentSessionEventTypes.ConversationItemAdded, createConversationItemAddedEvent(item));
  }

  /** @internal */
  _toolItemsAdded(items: (FunctionCall | FunctionCallOutput)[]): void {
    this._chatCtx.insert(items);
  }

  /** @internal */
  _updateAgentState(state: AgentState, options?: { startTime?: number; otelContext?: Context }) {
    if (this._agentState === state) {
      return;
    }

    if (state === 'speaking') {
      this.llmErrorCounts = 0;
      this.ttsErrorCounts = 0;

      if (this.agentSpeakingSpan === undefined) {
        this.agentSpeakingSpan = tracer.startSpan({
          name: 'agent_speaking',
          context: options?.otelContext ?? this.rootSpanContext,
          startTime: options?.startTime,
        });

        const localParticipant = this._roomIO?.localParticipant;
        if (localParticipant) {
          setParticipantSpanAttributes(this.agentSpeakingSpan, localParticipant);
        }
      }
    } else if (this.agentSpeakingSpan !== undefined) {
      // TODO(brian): PR4 - Set ATTR_END_TIME attribute if available
      this.agentSpeakingSpan.end();
      this.agentSpeakingSpan = undefined;
    }

    if (state === 'speaking' && this._aecWarmupRemaining > 0 && this._aecWarmupTimer === null) {
      this._aecWarmupTimer = setTimeout(() => this._onAecWarmupExpired(), this._aecWarmupRemaining);
      this.logger.debug(
        { warmupDurationMs: this._aecWarmupRemaining },
        'aec warmup active, disabling interruptions',
      );
    }

    const oldState = this._agentState;
    this._agentState = state;

    // Handle user away timer based on state changes
    if (state === 'listening' && this._userState === 'listening') {
      this._setUserAwayTimer();
    } else {
      this._cancelUserAwayTimer();
    }

    this.emit(
      AgentSessionEventTypes.AgentStateChanged,
      createAgentStateChangedEvent(oldState, state),
    );
  }

  /** @internal */
  _updateUserState(
    state: UserState,
    options?: { lastSpeakingTime?: number; otelContext?: Context },
  ) {
    if (this._userState === state) {
      return;
    }

    if (state === 'speaking' && this._userSpeakingSpan === undefined) {
      this._userSpeakingSpan = tracer.startSpan({
        name: 'user_speaking',
        context: options?.otelContext ?? this.rootSpanContext,
        startTime: options?.lastSpeakingTime,
      });

      const linked = this._roomIO?.linkedParticipant;
      if (linked) {
        setParticipantSpanAttributes(this._userSpeakingSpan, linked);
      }
    } else if (this._userSpeakingSpan !== undefined) {
      this._userSpeakingSpan.end(options?.lastSpeakingTime);
      this._userSpeakingSpan = undefined;
    }

    const oldState = this._userState;
    this._userState = state;

    // Handle user away timer based on state changes
    if (state === 'listening' && this._agentState === 'listening') {
      this._setUserAwayTimer();
    } else {
      this._cancelUserAwayTimer();
    }

    this.emit(
      AgentSessionEventTypes.UserStateChanged,
      createUserStateChangedEvent(oldState, state),
    );
  }

  // -- User changed input/output streams/sinks --
  private onAudioInputChanged(): void {
    if (!this.started) {
      return;
    }

    if (this.activity && this._input.audio) {
      this.activity.attachAudioInput(this._input.audio.stream);
    }
  }

  private onAudioOutputChanged(): void {
    if (
      this.started &&
      this.sessionOptions.turnHandling.interruption.resumeFalseInterruption &&
      this.output.audio &&
      !this.output.audio.canPause
    ) {
      this.logger.warn(
        {
          audioOutput: this.output.audio.constructor.name,
        },
        'resumeFalseInterruption is enabled, but the audio output does not support pause, ignored',
      );
    }
  }

  private onTextOutputChanged(): void {}

  private _setUserAwayTimer(): void {
    this._cancelUserAwayTimer();

    if (
      this.sessionOptions.userAwayTimeout === null ||
      this.sessionOptions.userAwayTimeout === undefined
    ) {
      return;
    }

    if (this._roomIO && !this._roomIO.isParticipantAvailable) {
      return;
    }

    this.userAwayTimer = setTimeout(() => {
      this.logger.debug('User away timeout triggered');
      this._updateUserState('away');
    }, this.sessionOptions.userAwayTimeout * 1000);
  }

  private _cancelUserAwayTimer(): void {
    if (this.userAwayTimer !== null) {
      clearTimeout(this.userAwayTimer);
      this.userAwayTimer = null;
    }
  }

  /** @internal */
  _onAecWarmupExpired(): void {
    if (this._aecWarmupRemaining > 0) {
      this.logger.debug('aec warmup expired, re-enabling interruptions');
    }

    this._aecWarmupRemaining = 0;
    if (this._aecWarmupTimer !== null) {
      clearTimeout(this._aecWarmupTimer);
      this._aecWarmupTimer = null;
    }
  }

  private _onUserInputTranscribed(ev: UserInputTranscribedEvent): void {
    if (ev.isFinal && this._userState !== 'speaking') {
      if (this._userState === 'away') {
        this.logger.debug('User returned from away state due to speech input');
        this._updateUserState('listening');
      } else if (this._userState === 'listening' && this._agentState === 'listening') {
        this._setUserAwayTimer();
      }
    }
  }

  private async closeImpl(
    reason: ShutdownReason,
    error: RealtimeModelError | LLMError | TTSError | STTError | null = null,
    drain: boolean = false,
  ): Promise<void> {
    if (this.rootSpanContext) {
      return otelContext.with(this.rootSpanContext, async () => {
        await this.closeImplInner(reason, error, drain);
      });
    }

    return this.closeImplInner(reason, error, drain);
  }

  private async closeImplInner(
    reason: ShutdownReason,
    error: RealtimeModelError | LLMError | TTSError | STTError | null = null,
    drain: boolean = false,
  ): Promise<void> {
    if (!this.started) {
      return;
    }

    this.closing = true;
    this._cancelUserAwayTimer();
    this._onAecWarmupExpired();
    this.off(AgentSessionEventTypes.UserInputTranscribed, this._onUserInputTranscribed);

    if (this.activity) {
      if (!drain) {
        try {
          await this.activity.interrupt({ force: true }).await;
        } catch (error) {
          this.logger.warn({ error }, 'Error interrupting activity');
        }
      }

      await this.activity.drain();
      // wait any uninterruptible speech to finish
      await this.activity.currentSpeech?.waitForPlayout();

      if (reason !== CloseReason.ERROR) {
        this.activity.commitUserTurn({ audioDetached: true, throwIfNotReady: false });
      }

      try {
        this.activity.detachAudioInput();
      } catch (error) {
        // Ignore detach errors during cleanup - source may not have been set
      }
    }

    // Close recorder before detaching inputs/outputs (keep reference for session report)
    if (this._recorderIO) {
      await this._recorderIO.close();
    }

    // detach the inputs and outputs
    this.input.audio = null;
    this.output.audio = null;
    this.output.transcription = null;

    await this.activity?.close();
    this.activity = undefined;

    const sessionToolsets = this._toolCtx.toolsets;
    await Promise.allSettled(sessionToolsets.map((toolset) => toolset.aclose()));

    if (this.sessionSpan) {
      this.sessionSpan.end();
      this.sessionSpan = undefined;
    }

    if (this._userSpeakingSpan) {
      this._userSpeakingSpan.end();
      this._userSpeakingSpan = undefined;
    }

    if (this.agentSpeakingSpan) {
      this.agentSpeakingSpan.end();
      this.agentSpeakingSpan = undefined;
    }

    this.started = false;

    this.emit(AgentSessionEventTypes.Close, createCloseEvent(reason, error));

    this._userState = 'listening';
    this._agentState = 'initializing';
    this.rootSpanContext = undefined;
    this.llmErrorCounts = 0;
    this.ttsErrorCounts = 0;

    await this.sessionHost?.close();
    this.sessionHost = undefined;

    await this._roomIO?.close();
    this._roomIO = undefined;

    this.logger.info({ reason, error }, 'AgentSession closed');
  }
}
