import type { AgentSession } from './agent_session.js';

export type UnknownUserData = unknown;

export class RunContext<UserData = UnknownUserData> {
  constructor(public readonly session: AgentSession<UserData>) {}
}
