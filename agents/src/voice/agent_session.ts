// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import type { ChatMessage } from '../llm/chat_context.js';
import { ChatContext } from '../llm/chat_context.js';
import type { LLM } from '../llm/index.js';
import { log } from '../log.js';
import type { STT } from '../stt/index.js';
import type { TTS } from '../tts/tts.js';
import type { VAD } from '../vad.js';
import type { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import type { _TurnDetector } from './audio_recognition.js';
import type { UserState } from './events.js';
import type { AudioOutput, TextOutput } from './io.js';
import { RoomIO } from './room_io/index.js';
import type { UnknownUserData } from './run_context.js';
import type { SpeechHandle } from './speech_handle.js';

export type AgentState = 'initializing' | 'thinking' | 'listening' | 'speaking';
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

// TODO(AJS-102): add and organize all agent session callbacks
export enum AgentSessionEvent {
  UserInputTranscribed = 'user_input_transcribed',
}

export type UserInputTranscribedEvent = {
  transcript: string;
  isFinal: boolean;
  speakerId: string | null;
};

export type AgentSessionCallbacks = {
  [AgentSessionEvent.UserInputTranscribed]: (ev: UserInputTranscribedEvent) => void;
};

export type AgentSessionOptions<UserData = UnknownUserData> = {
  turnDetection?: TurnDetectionMode;
  // TODO: Make voice pipeline components optional
  stt: STT;
  vad: VAD;
  llm: LLM;
  tts: TTS;
  userData?: UserData;
  voiceOptions?: Partial<VoiceOptions>;
};

export class AgentSession<
  UserData = UnknownUserData,
> extends (EventEmitter as new () => TypedEmitter<AgentSessionCallbacks>) {
  vad: VAD;
  stt: STT;
  llm: LLM;
  tts: TTS;
  turnDetection?: TurnDetectionMode;

  readonly options: VoiceOptions;

  private agent?: Agent;
  private activity?: AgentActivity;
  private nextActivity?: AgentActivity;
  private started = false;
  private userState: UserState = 'listening';

  private roomIO?: RoomIO;
  private logger = log();

  /** @internal */
  private _chatCtx: ChatContext;
  /** @internal */
  private _userData: UserData | undefined;
  /** @internal */
  private _agentState: AgentState = 'initializing';

  /** @internal */
  audioInput?: ReadableStream<AudioFrame>;
  /** @internal */
  audioOutput?: AudioOutput;
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

  async start(agent: Agent, room: Room): Promise<void> {
    if (this.started) {
      return;
    }

    this.agent = agent;
    this._updateAgentState('initializing');

    if (this.agent) {
      await this.updateActivity(this.agent);
    }

    this.roomIO = new RoomIO(this, room, this.tts.sampleRate, this.tts.numChannels);
    this.roomIO.start();

    if (this.audioInput) {
      this.activity?.updateAudioInput(this.audioInput);
    }

    this.logger.debug('AgentSession started');
    this.started = true;
    this._updateAgentState('listening');
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
      audio?: ReadableStream<AudioFrame> | null;
      allowInterruptions?: boolean | null;
      addToChatCtx?: boolean;
    },
  ): SpeechHandle {
    if (!this.activity) {
      throw new Error('AgentSession is not running');
    }

    this.logger.debug({ text, options }, 'say in agent session');

    return this.activity.say(text, options);
  }

  private async updateActivity(agent: Agent): Promise<void> {
    this.nextActivity = new AgentActivity(agent, this);

    // TODO(shubhra): Drain and close the old activity

    this.activity = this.nextActivity;
    this.nextActivity = undefined;

    if (this.activity) {
      await this.activity.start();
    }
  }

  get chatCtx(): ChatContext {
    return this._chatCtx.copy();
  }

  get agentState(): AgentState {
    return this._agentState;
  }

  /** @internal */
  _conversationItemAdded(item: ChatMessage): void {
    this._chatCtx.insert(item);
  }

  /** @internal */
  _updateAgentState(state: AgentState) {
    this._agentState = state;
  }

  /** @internal */
  _updateUserState(state: UserState) {
    this.userState = state;
  }
}
