// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JobContext, JobProcess } from './job.js';

/** @see {@link defineAgent} */
export interface Agent {
  entry: (ctx: JobContext) => Promise<void>;
  prewarm?: (proc: JobProcess) => unknown;
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
export function defineAgent(agent: Agent): Agent {
  return agent;
}
