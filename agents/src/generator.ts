// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JobContext, JobProcess } from './job.js';
import type { SimulationContext } from './simulation.js';

export const AGENT_DEFINITION_SYMBOL = Symbol.for('livekit.agents.AgentDefinition');

/** @see {@link defineAgent} */
export interface AgentDefinition<ProcessUserData = Record<string, unknown>> {
  entry: (ctx: JobContext<ProcessUserData>) => Promise<void>;
  prewarm?: (proc: JobProcess<ProcessUserData>) => unknown;
  /** Called when a simulation run driving this agent ends. Read the
   * simulator's verdict via `ctx.simulatorVerdict` and veto a pass from your
   * own checks with `ctx.fail(reason)`. Never called for normal sessions. */
  onSimulationEnd?: (ctx: SimulationContext) => unknown;
}

export type Agent<ProcessUserData = Record<string, unknown>> = AgentDefinition<ProcessUserData>;

/** Helper to check if an object is an agent before running it.
 *
 * @internal
 */
export function isAgent(obj: unknown): obj is AgentDefinition {
  return typeof obj === 'object' && obj !== null && AGENT_DEFINITION_SYMBOL in obj;
}

/**
 * Helper to define an agent according to the required interface.
 * @example A basic agent with entry and prewarm functions
 * ```
 * export default defineAgent({
 *   entry: async (ctx: JobContext) => { ... },
 *   prewarm: (proc: JobProcess) => { ... },
 * })
 * ```
 */
export function defineAgent<ProcessUserData = Record<string, unknown>>(
  agent: AgentDefinition<ProcessUserData>,
): AgentDefinition<ProcessUserData> {
  Object.defineProperty(agent, AGENT_DEFINITION_SYMBOL, {
    value: true,
  });
  return agent;
}
