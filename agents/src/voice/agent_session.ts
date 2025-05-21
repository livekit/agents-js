// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, AudioSource, Room } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { ChatContext } from '../llm/chat_context.js';
import type { ChatMessage } from '../llm/chat_context.js';
import type { LLM } from '../llm/index.js';
import { log } from '../log.js';
import type { AgentState } from '../pipeline/index.js';
import type { STT } from '../stt/index.js';
import type { TTS } from '../tts/tts.js';
import type { VAD } from '../vad.js';
import type { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import type { UserState } from './events.js';
import { RoomIO } from './room_io.js';

export interface VoiceOptions {
  allow_interruptions: boolean;
  discard_audio_if_uninterruptible: boolean;
  min_interruption_duration: number;
  min_interruption_words: number;
  min_endpointing_delay: number;
  max_endpointing_delay: number;
  max_tool_steps: number;
}

const defaultVoiceOptions: VoiceOptions = {
  allow_interruptions: true,
  discard_audio_if_uninterruptible: true,
  min_interruption_duration: 0.5,
  min_interruption_words: 0,
  min_endpointing_delay: 0.5,
  max_endpointing_delay: 6.0,
  max_tool_steps: 3,
} as const;

export class AgentSession {
  vad: VAD;
  stt: STT;
  llm: LLM;
  tts: TTS;

  private agent?: Agent;
  private activity?: AgentActivity;
  private nextActivity?: AgentActivity;
  private started = false;
  private userState: UserState = 'listening';
  private agentState: AgentState = 'initializing';

  private roomIO?: RoomIO;
  private logger = log();
  private _chatCtx: ChatContext;
  private _options: VoiceOptions;
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
    this._options = { ...defaultVoiceOptions, ...options };
  }

  async start(agent: Agent, room: Room): Promise<void> {
    if (this.started) {
      return;
    }

    this.agent = agent;

    if (this.agent) {
      await this.updateActivity(this.agent);
    }

    // TODO(AJS-38): update with TTS sample rate and num channels
    this.roomIO = new RoomIO(this, room, 0, 0);
    this.roomIO.start();

    if (this.audioInput) {
      this.activity?.updateAudioInput(this.audioInput);
    }

    this.logger.debug('AgentSession started');
    this.started = true;
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

  /** @internal */
  _conversationItemAdded(item: ChatMessage): void {
    this._chatCtx.insertItem(item);
  }

  get chatCtx(): ChatContext {
    // TODO(shubhra): Return a readonly object
    return this._chatCtx;
  }

  get options(): VoiceOptions {
    return this._options;
  }

  /** @internal */
  _updateAgentState(state: AgentState) {
    this.agentState = state;
  }

  /** @internal */
  _updateUserState(state: UserState) {
    this.userState = state;
  }
}
