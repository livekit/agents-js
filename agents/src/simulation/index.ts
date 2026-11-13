// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { getJobContext } from '../job.js';

export * from '../simulation.js';

/**
 * Pick the option of `knob` this job runs.
 *
 * `lk agent simulate --compare llm=gpt-5,gemini` dispatches each scenario once
 * per option; each job's dispatch names the option it runs. Outside a
 * simulation, or when the dispatch makes no choice for `knob`, returns
 * `options[opts.default]`.
 *
 * @example
 * ```ts
 * import { simulation } from '@livekit/agents';
 *
 * const llm = simulation.choose(
 *   'llm',
 *   {
 *     'gpt-5': new inference.LLM({ model: 'openai/gpt-5' }),
 *     gemini: new inference.LLM({ model: 'google/gemini-2.5-flash' }),
 *   },
 *   { default: 'gpt-5' },
 * );
 * ```
 *
 * @throws Error if `opts.default` is not one of `options`, or the dispatch
 * names an option `options` does not have.
 */
export function choose<T>(knob: string, options: Record<string, T>, opts: { default: string }): T {
  const names = () => Object.keys(options).join(', ');
  if (!Object.hasOwn(options, opts.default)) {
    throw new Error(
      `choose('${knob}'): default '${opts.default}' is not one of the options [${names()}]`,
    );
  }
  const chosen = getJobContext(false)?.simulationContext()?.choices[knob] ?? opts.default;
  if (!Object.hasOwn(options, chosen)) {
    throw new Error(
      `choose('${knob}'): the simulation asked for option '${chosen}', which is not one of the options [${names()}]`,
    );
  }
  return options[chosen]!;
}
