// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { FunctionCall } from '../llm/chat_context.js';
import type { AgentSession } from './agent_session.js';
import type { SpeechHandle } from './speech_handle.js';

export type UnknownUserData = unknown;

export class RunContext<UserData = UnknownUserData> {
  constructor(
    public readonly session: AgentSession<UserData>,
    public readonly speechHandle: SpeechHandle,
    public readonly functionCall: FunctionCall,
  ) {}

  get userData(): UserData {
    return this.session.userData;
  }
}
