// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import { ChatContext, ChatMessage } from '../llm/chat_context.js';
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
}

const defaultVoiceOptions: VoiceOptions = {
  allowInterruptions: true,
  discardAudioIfUninterruptible: true,
  minInterruptionDuration: 500,
  minInterruptionWords: 0,
  minEndpointingDelay: 500,
  maxEndpointingDelay: 6000,
  maxToolSteps: 3,
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
  stt?: STT;
  vad?: VAD;
  llm?: LLM | RealtimeModel;
  tts?: TTS;
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
    this.stt = stt;
    this.llm = llm;
    this.tts = tts;
    this.turnDetection = turnDetection;
    this._userData = userData;

    // configurable IO
    this._input = new AgentInput(this.onAudioInputChanged);
    this._output = new AgentOutput(this.onAudioOutputChanged, this.onTextOutputChanged);

    // This is the "global" chat context, it holds the entire conversation history
    this._chatCtx = ChatContext.empty();
    this.options = { ...defaultVoiceOptions, ...voiceOptions };
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

  set userData(value: UserData) {
    this._userData = value;
  }

  async start({
    agent,
    room,
    inputOptions,
    outputOptions,
  }: {
    agent: Agent;
    room: Room;
    inputOptions?: Partial<RoomInputOptions>;
    outputOptions?: Partial<RoomOutputOptions>;
  }): Promise<void> {
    if (this.started) {
      return;
    }

    this.agent = agent;
    this._updateAgentState('initializing');

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

    this.updateActivity(this.agent);

    // Log used IO configuration
    this.logger.debug(
      `using audio io: ${this.input.audio ? '`' + this.input.audio.constructor.name + '`' : '(none)'} -> \`AgentSession\` -> ${this.output.audio ? '`' + this.output.audio.constructor.name + '`' : '(none)'}`,
    );

    this.logger.debug(
      `using transcript io: \`AgentSession\` -> ${this.output.transcription ? '`' + this.output.transcription.constructor.name + '`' : '(none)'}`,
    );

    this.logger.debug('AgentSession started');
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

    if (this.activity) {
      await this.activity.drain();
      await this.activity.close();
    }

    this.activity = this.nextActivity;
    this.nextActivity = undefined;

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

    const oldState = this._agentState;
    this._agentState = state;
    this.emit(
      AgentSessionEventTypes.AgentStateChanged,
      createAgentStateChangedEvent(oldState, state),
    );
  }

  /** @internal */
  _updateUserState(state: UserState) {
    if (this.userState === state) {
      return;
    }

    const oldState = this.userState;
    this.userState = state;
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

  private async closeImpl(
    reason: CloseReason,
    error: RealtimeModelError | LLMError | TTSError | STTError | null = null,
    drain: boolean = false,
  ): Promise<void> {
    if (!this.started) {
      return;
    }

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
