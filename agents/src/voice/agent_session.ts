// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, AudioSource, Room } from '@livekit/rtc-node';
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
import type { UserState } from './events.js';
import { RoomIO } from './room_io.js';

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

export class AgentSession {
  vad: VAD;
  stt: STT;
  llm: LLM;
  tts: TTS;
  readonly options: VoiceOptions;

  private agent?: Agent;
  private activity?: AgentActivity;
  private nextActivity?: AgentActivity;
  private started = false;
  private userState: UserState = 'listening';
  private _agentState: AgentState = 'initializing';

  private roomIO?: RoomIO;
  private logger = log();
  private _chatCtx: ChatContext;
  /** @internal */
  audioInput?: ReadableStream<AudioFrame>;
  /** @internal */
  audioOutput?: AudioSource;

  constructor(
    vad: VAD,
    stt: STT,
    llm: LLM,
    tts: TTS,
    options: Partial<VoiceOptions> = defaultVoiceOptions,
  ) {
    this.vad = vad;
    this.stt = stt;
    this.llm = llm;
    this.tts = tts;
    // TODO(shubhra): Add tools to chat context initalzation
    this._chatCtx = new ChatContext();
    this.options = { ...defaultVoiceOptions, ...options };
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
    // TODO(shubhra): Return a readonly object
    return this._chatCtx;
  }

  get agentState(): AgentState {
    return this._agentState;
  }

  /** @internal */
  _conversationItemAdded(item: ChatMessage): void {
    this._chatCtx.insertItem(item);
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
