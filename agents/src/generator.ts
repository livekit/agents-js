// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JobContext, JobProcess } from './job.js';

/** @see {@link defineAgent} */
export interface Agent {
  entry: (ctx: JobContext) => Promise<void>;
  prewarm?: (proc: JobProcess) => unknown;
}

/** Helper to check if an object is an agent before running it.
 *
 * @internal
 */
export function isAgent(obj: unknown): obj is Agent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'entry' in obj &&
    typeof (obj as Agent).entry === 'function' &&
    (('prewarm' in obj && typeof (obj as Agent).prewarm === 'function') || !('prewarm' in obj))
  );
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
