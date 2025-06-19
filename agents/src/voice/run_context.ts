// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AgentSession } from './agent_session.js';

export type UnknownUserData = unknown;

export class RunContext<UserData = UnknownUserData> {
  constructor(public readonly session: AgentSession<UserData>) {}

  get userData(): UserData {
    return this.session.userData;
  }
}
