// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import { ChatContext, ChatMessage } from '../llm/chat_context.js';
import type { LLM, RealtimeModel, ToolChoice } from '../llm/index.js';
import { log } from '../log.js';
import type { STT } from '../stt/index.js';
import type { TTS } from '../tts/tts.js';
import type { VAD } from '../vad.js';
import type { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import type { _TurnDetector } from './audio_recognition.js';
import {
  AgentSessionEventTypes,
  type AgentState,
  type AgentStateChangedEvent,
  type ConversationItemAddedEvent,
  type FunctionToolsExecutedEvent,
  type MetricsCollectedEvent,
  type SpeechCreatedEvent,
  type UserInputTranscribedEvent,
  type UserState,
  type UserStateChangedEvent,
  createAgentStateChangedEvent,
  createConversationItemAddedEvent,
  createUserStateChangedEvent,
} from './events.js';
import type { AudioOutput, TextOutput } from './io.js';
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

  /** @internal */
  _audioInput?: ReadableStream<AudioFrame>;
  /** @internal */
  _audioOutput?: AudioOutput;
  /** @internal */
  _transcriptionOutput?: TextOutput;

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

    // This is the "global" chat context, it holds the entire conversation history
    this._chatCtx = ChatContext.empty();
    this.options = { ...defaultVoiceOptions, ...voiceOptions };
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

    this.roomIO = new RoomIO({
      agentSession: this,
      room,
      inputOptions,
      outputOptions,
    });
    this.roomIO.start();

    this.updateActivity(this.agent);

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

    if (this._audioInput) {
      this.activity.updateAudioInput(this._audioInput);
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
}
