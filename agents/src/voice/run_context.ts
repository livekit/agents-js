// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { FunctionCall } from '../llm/chat_context.js';
import type { AgentSession } from './agent_session.js';
import type { SpeechHandle } from './speech_handle.js';

export type UnknownUserData = unknown;

export class RunContext<UserData = UnknownUserData> {
  private readonly initialStepIdx: number;
  constructor(
    public readonly session: AgentSession<UserData>,
    public readonly speechHandle: SpeechHandle,
    public readonly functionCall: FunctionCall,
  ) {
    this.initialStepIdx = speechHandle.numSteps - 1;
  }
  get userData(): UserData {
    return this.session.userData;
  }

  /**
   * Waits for the speech playout corresponding to this function call step.
   *
   * Unlike {@link SpeechHandle.waitForPlayout}, which waits for the full
   * assistant turn to complete (including all function tools),
   * this method only waits for the assistant's spoken response prior to running
   * this tool to finish playing.
   */
  async waitForPlayout() {
    return this.speechHandle._waitForGeneration(this.initialStepIdx);
  }
}
