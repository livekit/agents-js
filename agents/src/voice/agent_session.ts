// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
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
import { getJobContext } from '../job.js';
import { AgentHandoffItem, ChatContext, ChatMessage } from '../llm/chat_context.js';
import type { LLM, RealtimeModel, RealtimeModelError, ToolChoice } from '../llm/index.js';
import type { LLMError } from '../llm/llm.js';
import { log } from '../log.js';
import type { STT } from '../stt/index.js';
import type { STTError } from '../stt/stt.js';
import type { TTS, TTSError } from '../tts/tts.js';
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
import { RoomIO, type RoomInputOptions, type RoomOutputOptions } from './room_io/index.js';
import type { UnknownUserData } from './run_context.js';
import type { SpeechHandle } from './speech_handle.js';

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

  /** @internal */
  _recordedEvents: AgentEvent[] = [];

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
    } = opts;

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

    this.on(AgentSessionEventTypes.UserInputTranscribed, this._onUserInputTranscribed.bind(this));
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

  set userData(value: UserData) {
    this._userData = value;
  }

  async start({
    // TODO(brian): PR2 - Add setupCloudTracer() call if on LiveKit Cloud with recording enabled
    // TODO(brian): PR3 - Add span: this._sessionSpan = tracer.startSpan('agent_session'), store as instance property
    // TODO(brian): PR4 - Add setupCloudLogger() call in setupCloudTracer() to setup OTEL logging with Pino bridge
    agent,
    room,
    inputOptions,
    outputOptions,
    record = true,
  }: {
    agent: Agent;
    room: Room;
    inputOptions?: Partial<RoomInputOptions>;
    outputOptions?: Partial<RoomOutputOptions>;
    record?: boolean;
  }): Promise<void> {
    if (this.started) {
      return;
    }

    this.agent = agent;
    this._updateAgentState('initializing');

    const tasks: Promise<void>[] = [];
    // Check for existing input/output configuration and warn if needed
    if (this.input.audio && inputOptions?.audioEnabled !== false) {
      this.logger.warn('RoomIO audio input is enabled but input.audio is already set, ignoring..');
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

    const ctx = getJobContext();
    if (ctx && ctx.room === room && !room.isConnected) {
      this.logger.debug('Auto-connecting to room via job context');
      tasks.push(ctx.connect());
    }

    if (record) {
      if (ctx._primaryAgentSession === undefined) {
        ctx._primaryAgentSession = this;
      } else {
        throw new Error(
          'Only one `AgentSession` can be the primary at a time. If you want to ignore primary designation, use session.start(record=False).',
        );
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
    this._updateAgentState('listening');
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

    return this.activity.say(text, options);
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

    if (this.activity.draining) {
      if (!this.nextActivity) {
        throw new Error('AgentSession is closing, cannot use generateReply()');
      }
      return this.nextActivity.generateReply({ userMessage, ...options });
    }

    return this.activity.generateReply({ userMessage, ...options });
  }

  private async updateActivity(agent: Agent): Promise<void> {
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
    this.logger.debug({ previousActivity, agent }, 'Agent handoff inserted into chat context');

    await this.activity.start();

    if (this._input.audio) {
      this.activity.attachAudioInput(this._input.audio.stream);
    }
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

  /** @internal */
  _closeSoon({
    reason,
    drain = false,
    error = null,
  }: {
    reason: CloseReason;
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
  _updateAgentState(state: AgentState) {
    if (this._agentState === state) {
      return;
    }

    // TODO(brian): PR3 - Add span: if state === 'speaking' && !this._agentSpeakingSpan, create tracer.startSpan('agent_speaking') with participant attributes
    // TODO(brian): PR3 - Add span: if state !== 'speaking' && this._agentSpeakingSpan, end and clear this._agentSpeakingSpan
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
  _updateUserState(state: UserState, _lastSpeakingTime?: number) {
    if (this.userState === state) {
      return;
    }

    // TODO(brian): PR3 - Add span: if state === 'speaking' && !this._userSpeakingSpan, create tracer.startSpan('user_speaking') with participant attributes
    // TODO(brian): PR3 - Add span: if state !== 'speaking' && this._userSpeakingSpan, end and clear this._userSpeakingSpan
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
    reason: CloseReason,
    error: RealtimeModelError | LLMError | TTSError | STTError | null = null,
    drain: boolean = false,
  ): Promise<void> {
    if (!this.started) {
      return;
    }

    this._cancelUserAwayTimer();

    if (this.activity) {
      if (!drain) {
        try {
          this.activity.interrupt();
        } catch (error) {
          // uninterruptible speech [copied from python]
          // TODO(shubhra): force interrupt or wait for it to finish?
          // it might be an audio played from the error callback
        }
      }
      await this.activity.drain();
      // wait any uninterruptible speech to finish
      await this.activity.currentSpeech?.waitForPlayout();
      this.activity.detachAudioInput();
    }

    // detach the inputs and outputs
    this.input.audio = null;
    this.output.audio = null;
    this.output.transcription = null;

    await this.roomIO?.close();
    this.roomIO = undefined;

    await this.activity?.close();
    this.activity = undefined;

    this.started = false;

    this.emit(AgentSessionEventTypes.Close, createCloseEvent(reason, error));

    this.userState = 'listening';
    this._agentState = 'initializing';

    this.logger.info({ reason, error }, 'AgentSession closed');
  }
}
