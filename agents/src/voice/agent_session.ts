// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import type { Context, Span } from '@opentelemetry/api';
import { ROOT_CONTEXT, context as otelContext, trace } from '@opentelemetry/api';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import {
  LLM as InferenceLLM,
  STT as InferenceSTT,
  TTS as InferenceTTS,
  type LLMModels,
  type STTModelString,
  type TTSModelString,
} from '../inference/index.js';
import { type JobContext, getJobContext } from '../job.js';
import type { FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import { AgentHandoffItem, ChatContext, ChatMessage } from '../llm/chat_context.js';
import type { LLM, RealtimeModel, RealtimeModelError, ToolChoice } from '../llm/index.js';
import type { LLMError } from '../llm/llm.js';
import { log } from '../log.js';
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
import type { VAD } from '../vad.js';
import type { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import type { _TurnDetector } from './audio_recognition.js';
import {
  type AgentEvent,
  AgentSessionEventTypes,
  type AgentState,
  type AgentStateChangedEvent,
  type CloseEvent,
  CloseReason,
  type ConversationItemAddedEvent,
  type ErrorEvent,
  type FunctionToolsExecutedEvent,
  type MetricsCollectedEvent,
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
import { RecorderIO } from './recorder_io/index.js';
import { RoomIO, type RoomInputOptions, type RoomOutputOptions } from './room_io/index.js';
import type { UnknownUserData } from './run_context.js';
import type { SpeechHandle } from './speech_handle.js';
import { RunResult } from './testing/run_result.js';

export interface VoiceOptions {
  allowInterruptions: boolean;
  discardAudioIfUninterruptible: boolean;
  minInterruptionDuration: number;
  minInterruptionWords: number;
  minEndpointingDelay: number;
  maxEndpointingDelay: number;
  maxToolSteps: number;
  preemptiveGeneration: boolean;
  userAwayTimeout?: number | null;
  useTtsAlignedTranscript: boolean;
}

const defaultVoiceOptions: VoiceOptions = {
  allowInterruptions: true,
  discardAudioIfUninterruptible: true,
  minInterruptionDuration: 500,
  minInterruptionWords: 0,
  minEndpointingDelay: 500,
  maxEndpointingDelay: 6000,
  maxToolSteps: 3,
  preemptiveGeneration: false,
  userAwayTimeout: 15.0,
  useTtsAlignedTranscript: true,
} as const;

export type TurnDetectionMode = 'stt' | 'vad' | 'realtime_llm' | 'manual' | _TurnDetector;

export type AgentSessionCallbacks = {
  [AgentSessionEventTypes.UserInputTranscribed]: (ev: UserInputTranscribedEvent) => void;
  [AgentSessionEventTypes.AgentStateChanged]: (ev: AgentStateChangedEvent) => void;
  [AgentSessionEventTypes.UserStateChanged]: (ev: UserStateChangedEvent) => void;
  [AgentSessionEventTypes.ConversationItemAdded]: (ev: ConversationItemAddedEvent) => void;
  [AgentSessionEventTypes.FunctionToolsExecuted]: (ev: FunctionToolsExecutedEvent) => void;
  [AgentSessionEventTypes.MetricsCollected]: (ev: MetricsCollectedEvent) => void;
  [AgentSessionEventTypes.SpeechCreated]: (ev: SpeechCreatedEvent) => void;
  [AgentSessionEventTypes.Error]: (ev: ErrorEvent) => void;
  [AgentSessionEventTypes.Close]: (ev: CloseEvent) => void;
};

export type AgentSessionOptions<UserData = UnknownUserData> = {
  turnDetection?: TurnDetectionMode;
  stt?: STT | STTModelString;
  vad?: VAD;
  llm?: LLM | RealtimeModel | LLMModels;
  tts?: TTS | TTSModelString;
  userData?: UserData;
  voiceOptions?: Partial<VoiceOptions>;
  connOptions?: SessionConnectOptions;
};

export class AgentSession<
  UserData = UnknownUserData,
> extends (EventEmitter as new () => TypedEmitter<AgentSessionCallbacks>) {
  vad?: VAD;
  stt?: STT;
  llm?: LLM | RealtimeModel;
  tts?: TTS;
  turnDetection?: TurnDetectionMode;

  readonly options: VoiceOptions;

  private agent?: Agent;
  private activity?: AgentActivity;
  private nextActivity?: AgentActivity;
  private started = false;
  private userState: UserState = 'listening';

  private roomIO?: RoomIO;
  private logger = log();

  private _chatCtx: ChatContext;
  private _userData: UserData | undefined;
  private _agentState: AgentState = 'initializing';

  private _input: AgentInput;
  private _output: AgentOutput;

  private closingTask: Promise<void> | null = null;
  private userAwayTimer: NodeJS.Timeout | null = null;

  // Connection options for STT, LLM, and TTS
  private _connOptions: ResolvedSessionConnectOptions;

  // Unrecoverable error counts, reset after agent speaking
  private llmErrorCounts = 0;
  private ttsErrorCounts = 0;

  private sessionSpan?: Span;
  private userSpeakingSpan?: Span;
  private agentSpeakingSpan?: Span;

  /** @internal */
  _recorderIO?: RecorderIO;

  /** @internal */
  rootSpanContext?: Context;

  /** @internal */
  _recordedEvents: AgentEvent[] = [];

  /** @internal */
  _enableRecording = false;

  /** @internal - Timestamp when the session started (milliseconds) */
  _startedAt?: number;

  /** @internal - Current run state for testing */
  _globalRunState?: RunResult;

  constructor(opts: AgentSessionOptions<UserData>) {
    super();

    const {
      vad,
      stt,
      llm,
      tts,
      turnDetection,
      userData,
      voiceOptions = defaultVoiceOptions,
      connOptions,
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

    this.vad = vad;

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

    this.turnDetection = turnDetection;
    this._userData = userData;

    // configurable IO
    this._input = new AgentInput(this.onAudioInputChanged);
    this._output = new AgentOutput(this.onAudioOutputChanged, this.onTextOutputChanged);

    // This is the "global" chat context, it holds the entire conversation history
    this._chatCtx = ChatContext.empty();
    this.options = { ...defaultVoiceOptions, ...voiceOptions };

    this._onUserInputTranscribed = this._onUserInputTranscribed.bind(this);
    this.on(AgentSessionEventTypes.UserInputTranscribed, this._onUserInputTranscribed);
  }

  emit<K extends keyof AgentSessionCallbacks>(
    event: K,
    ...args: Parameters<AgentSessionCallbacks[K]>
  ): boolean {
    const eventData = args[0] as AgentEvent;
    this._recordedEvents.push(eventData);
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

  /** Connection options for STT, LLM, and TTS. */
  get connOptions(): ResolvedSessionConnectOptions {
    return this._connOptions;
  }

  get useTtsAlignedTranscript(): boolean {
    return this.options.useTtsAlignedTranscript;
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

    if (room && !this.roomIO) {
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

      this.roomIO = new RoomIO({
        agentSession: this,
        room,
        inputOptions,
        outputOptions,
      });
      this.roomIO.start();
    }

    let ctx: JobContext | undefined = undefined;
    try {
      ctx = getJobContext();
    } catch {
      // JobContext is not available in evals
    }

    if (ctx) {
      if (room && ctx.room === room && !room.isConnected) {
        this.logger.debug('Auto-connecting to room via job context');
        tasks.push(ctx.connect());
      }

      if (ctx._primaryAgentSession === undefined) {
        ctx._primaryAgentSession = this;
      } else if (this._enableRecording) {
        throw new Error(
          'Only one `AgentSession` can be the primary at a time. If you want to ignore primary designation, use `session.start({ record: false })`.',
        );
      }

      if (this.input.audio && this.output.audio && this._enableRecording) {
        this._recorderIO = new RecorderIO({ agentSession: this });
        this.input.audio = this._recorderIO.recordInput(this.input.audio);
        this.output.audio = this._recorderIO.recordOutput(this.output.audio);

        // Start recording to session directory
        const sessionDir = ctx.sessionDirectory;
        if (sessionDir) {
          tasks.push(this._recorderIO.start(`${sessionDir}/audio.ogg`));
        }
      }
    }

    // TODO(AJS-265): add shutdown callback to job context
    tasks.push(this.updateActivity(this.agent));

    await Promise.allSettled(tasks);

    // Log used IO configuration
    this.logger.debug(
      `using audio io: ${this.input.audio ? '`' + this.input.audio.constructor.name + '`' : '(none)'} -> \`AgentSession\` -> ${this.output.audio ? '`' + this.output.audio.constructor.name + '`' : '(none)'}`,
    );

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
    record?: boolean;
  }): Promise<void> {
    if (this.started) {
      return;
    }

    let ctx: JobContext | undefined = undefined;
    try {
      ctx = getJobContext();

      if (record === undefined) {
        record = ctx.job.enableRecording;
      }

      this._enableRecording = record;

      if (this._enableRecording) {
        ctx.initRecording();
      }
    } catch (error) {
      // JobContext is not available in evals
      this.logger.warn('JobContext is not available');
    }

    this.sessionSpan = tracer.startSpan({
      name: 'agent_session',
      context: ROOT_CONTEXT,
    });

    this.rootSpanContext = trace.setSpan(ROOT_CONTEXT, this.sessionSpan);

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

    if (this.started) {
      this.updateActivity(agent);
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

    const doSay = (activity: AgentActivity) => {
      return activity.say(text, options);
    };

    // attach to the session span if called outside of the AgentSession
    const activeSpan = trace.getActiveSpan();
    if (!activeSpan && this.rootSpanContext) {
      return otelContext.with(this.rootSpanContext, () => doSay(this.activity!));
    }

    return doSay(this.activity);
  }

  interrupt() {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }
    return this.activity.interrupt();
  }

  generateReply(options?: {
    userInput?: string;
    instructions?: string;
    toolChoice?: ToolChoice;
    allowInterruptions?: boolean;
  }): SpeechHandle {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }

    const userMessage = options?.userInput
      ? new ChatMessage({
          role: 'user',
          content: options.userInput,
        })
      : undefined;

    const doGenerateReply = (activity: AgentActivity, nextActivity?: AgentActivity) => {
      if (activity.draining) {
        if (!nextActivity) {
          throw new Error('AgentSession is closing, cannot use generateReply()');
        }
        return nextActivity.generateReply({ userMessage, ...options });
      }
      return activity.generateReply({ userMessage, ...options });
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
   * @param options - Run options including user input
   * @returns A RunResult that resolves when the agent finishes responding
   *
   * TODO: Add outputType parameter for typed outputs (parity with Python)
   */
  run(options: { userInput: string }): RunResult {
    if (this._globalRunState && !this._globalRunState.done()) {
      throw new Error('nested runs are not supported');
    }

    const runState = new RunResult({ userInput: options.userInput });
    this._globalRunState = runState;
    this.generateReply({ userInput: options.userInput });

    return runState;
  }

  private async updateActivity(agent: Agent): Promise<void> {
    const runWithContext = async () => {
      // TODO(AJS-129): add lock to agent activity core lifecycle
      this.nextActivity = new AgentActivity(agent, this);

      const previousActivity = this.activity;

      if (this.activity) {
        await this.activity.drain();
        await this.activity.close();
      }

      this.activity = this.nextActivity;
      this.nextActivity = undefined;

      this._chatCtx.insert(
        new AgentHandoffItem({
          oldAgentId: previousActivity?.agent.id,
          newAgentId: agent.id,
        }),
      );
      this.logger.debug(
        { previousAgentId: previousActivity?.agent.id, newAgentId: agent.id },
        'Agent handoff inserted into chat context',
      );

      await this.activity.start();

      if (this._input.audio) {
        this.activity.attachAudioInput(this._input.audio.stream);
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

  get currentAgent(): Agent {
    if (!this.agent) {
      throw new Error('AgentSession is not running');
    }

    return this.agent;
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
    this.closeImpl(reason, error, drain);
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

    this.logger.error(error, 'AgentSession is closing due to unrecoverable error');

    this.closingTask = (async () => {
      await this.closeImpl(CloseReason.ERROR, error);
    })().then(() => {
      this.closingTask = null;
    });
  }

  /** @internal */
  _conversationItemAdded(item: ChatMessage): void {
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
      // Reset error counts when agent starts speaking
      this.llmErrorCounts = 0;
      this.ttsErrorCounts = 0;

      if (this.agentSpeakingSpan === undefined) {
        this.agentSpeakingSpan = tracer.startSpan({
          name: 'agent_speaking',
          context: options?.otelContext ?? this.rootSpanContext,
          startTime: options?.startTime,
        });

        // TODO(brian): PR4 - Set participant attributes if roomIO.room.localParticipant is available
        // (Ref: Python agent_session.py line 1161-1164)
      }
    } else if (this.agentSpeakingSpan !== undefined) {
      // TODO(brian): PR4 - Set ATTR_END_TIME attribute if available
      this.agentSpeakingSpan.end();
      this.agentSpeakingSpan = undefined;
    }

    const oldState = this._agentState;
    this._agentState = state;

    // Handle user away timer based on state changes
    if (state === 'listening' && this.userState === 'listening') {
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
  _updateUserState(state: UserState, lastSpeakingTime?: number) {
    if (this.userState === state) {
      return;
    }

    if (state === 'speaking' && this.userSpeakingSpan === undefined) {
      this.userSpeakingSpan = tracer.startSpan({
        name: 'user_speaking',
        context: this.rootSpanContext,
        startTime: lastSpeakingTime,
      });

      // TODO(brian): PR4 - Set participant attributes if roomIO.linkedParticipant is available
      // (Ref: Python agent_session.py line 1192-1195)
    } else if (this.userSpeakingSpan !== undefined) {
      this.userSpeakingSpan.end(lastSpeakingTime);
      this.userSpeakingSpan = undefined;
    }

    const oldState = this.userState;
    this.userState = state;

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

  private onAudioOutputChanged(): void {}

  private onTextOutputChanged(): void {}

  private _setUserAwayTimer(): void {
    this._cancelUserAwayTimer();

    if (this.options.userAwayTimeout === null || this.options.userAwayTimeout === undefined) {
      return;
    }

    if (this.roomIO && !this.roomIO.isParticipantAvailable) {
      return;
    }

    this.userAwayTimer = setTimeout(() => {
      this.logger.debug('User away timeout triggered');
      this._updateUserState('away');
    }, this.options.userAwayTimeout * 1000);
  }

  private _cancelUserAwayTimer(): void {
    if (this.userAwayTimer !== null) {
      clearTimeout(this.userAwayTimer);
      this.userAwayTimer = null;
    }
  }

  private _onUserInputTranscribed(ev: UserInputTranscribedEvent): void {
    if (this.userState === 'away' && ev.isFinal) {
      this.logger.debug('User returned from away state due to speech input');
      this._updateUserState('listening');
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

    this._cancelUserAwayTimer();
    this.off(AgentSessionEventTypes.UserInputTranscribed, this._onUserInputTranscribed);

    if (this.activity) {
      if (!drain) {
        try {
          this.activity.interrupt();
        } catch (error) {
          // TODO(shubhra): force interrupt or wait for it to finish?
          // it might be an audio played from the error callback
        }
      }
      await this.activity.drain();
      // wait any uninterruptible speech to finish
      await this.activity.currentSpeech?.waitForPlayout();
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

    await this.roomIO?.close();
    this.roomIO = undefined;

    await this.activity?.close();
    this.activity = undefined;

    if (this.sessionSpan) {
      this.sessionSpan.end();
      this.sessionSpan = undefined;
    }

    if (this.userSpeakingSpan) {
      this.userSpeakingSpan.end();
      this.userSpeakingSpan = undefined;
    }

    if (this.agentSpeakingSpan) {
      this.agentSpeakingSpan.end();
      this.agentSpeakingSpan = undefined;
    }

    this.started = false;

    this.emit(AgentSessionEventTypes.Close, createCloseEvent(reason, error));

    this.userState = 'listening';
    this._agentState = 'initializing';
    this.rootSpanContext = undefined;
    this.llmErrorCounts = 0;
    this.ttsErrorCounts = 0;

    this.logger.info({ reason, error }, 'AgentSession closed');
  }
}
