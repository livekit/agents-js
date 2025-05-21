// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { log } from '../log.js';
import type { AgentState } from '../pipeline/index.js';
import type { STT } from '../stt/index.js';
import type { VAD } from '../vad.js';
import type { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import type { UserState } from './events.js';
import { RoomIO } from './room_io.js';

export class AgentSession {
  vad: VAD;
  stt: STT;

  private agent?: Agent;
  private activity?: AgentActivity;
  private nextActivity?: AgentActivity;
  private started = false;
  private userState: UserState = 'listening';
  private agentState: AgentState = 'initializing';

  private roomIO?: RoomIO;
  private logger = log();

  /** @internal */
  audioInput?: ReadableStream<AudioFrame>;

  constructor(vad: VAD, stt: STT) {
    this.vad = vad;
    this.stt = stt;
  }

  async start(agent: Agent, room: Room): Promise<void> {
    if (this.started) {
      return;
    }

    this.agent = agent;

    if (this.agent) {
      await this.updateActivity(this.agent);
    }

    this.roomIO = new RoomIO(this, room);
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
  _updateAgentState(state: AgentState) {
    this.agentState = state;
  }

  /** @internal */
  _updateUserState(state: UserState) {
    this.userState = state;
  }
}
