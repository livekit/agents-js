// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JobContext } from './job_context.js';

export type entryFunction = (job: JobContext) => Promise<void>;

export interface Agent {
  entry: entryFunction;
}

/**
 * Helper to define an agent according to the required interface.
 * @example export default defineAgent(async (job: JobContext) => {
 *   // ...
 * });
 */
export function defineAgent(agent: Agent): Agent {
  return agent;
}
