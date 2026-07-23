// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  Scenario,
  ScenarioGroup,
  SimulationDispatch,
  SimulationMode,
  SimulationRun,
  SimulationRun_Job,
} from '@livekit/protocol';
import type { JobContext } from './job.js';

export {
  Scenario,
  ScenarioGroup,
  SimulationDispatch,
  SimulationMode,
  SimulationRun,
  SimulationRun_Job,
};

/** A pass/fail verdict for a scenario, with a human-readable reason. */
export interface SimulationVerdict {
  success: boolean;
  reason: string;
}

/** Decoded form of a Scenario's `userdata` (arbitrary JSON). On the wire it is
 * a JSON-encoded string; in a scenarios.yaml it is written as a nested mapping. */
export type ScenarioUserdata = { [key: string]: unknown };

/** Decode a protojson `SimulationDispatch`, ignoring unknown fields so newer
 * servers can add fields without breaking older SDKs. Throws on malformed
 * input. */
export function parseSimulationDispatch(raw: string): SimulationDispatch {
  return SimulationDispatch.fromJsonString(raw, { ignoreUnknownFields: true });
}

/**
 * Passed to the `onSimulationEnd` callback while running under a simulation.
 *
 * Carries two verdicts, both recorded for the run:
 * - {@link simulatorVerdict}: the simulator's verdict (its LLM judgment of the chat).
 * - {@link userVerdict}: your own veto, set via {@link fail} from richer checks
 *   (e.g. comparing mock backend state against the benchmark target in
 *   `scenario.userdata`). The effective result is the AND of the two: your
 *   check can fail a run the simulator passed, but it can never rescue one, so
 *   there is no `success()`; not calling {@link fail} leaves the simulator's
 *   verdict to stand.
 *
 * Use {@link jobContext} to reach the running session and the room.
 */
export class SimulationContext {
  /** @internal */
  _dispatch: SimulationDispatch;

  #jobCtx: JobContext;
  #run?: SimulationRun;
  #job?: SimulationRun_Job;
  #simulatorVerdict?: SimulationVerdict;
  #userVerdict?: SimulationVerdict;

  constructor(dispatch: SimulationDispatch, jobCtx: JobContext) {
    this._dispatch = dispatch;
    this.#jobCtx = jobCtx;
  }

  get scenario(): Scenario {
    return (this._dispatch.scenario ??= new Scenario());
  }

  /** How the simulated user interacts with the agent (text chat or audio).
   * Unspecified is treated as text, since simulations predating the field
   * were all text-only. */
  get simulationMode(): SimulationMode {
    if (this._dispatch.mode === SimulationMode.UNSPECIFIED) {
      return SimulationMode.TEXT;
    }
    return this._dispatch.mode;
  }

  get simulationRun(): SimulationRun | undefined {
    return this.#run;
  }

  get simulationJob(): SimulationRun_Job | undefined {
    return this.#job;
  }

  /** The simulator's verdict (its LLM judgment of the conversation). Read-only;
   * recorded alongside your {@link userVerdict}.
   *
   * Only available once the simulation has ended, i.e. inside
   * `onSimulationEnd`. Throws if accessed earlier (e.g. from the entrypoint). */
  get simulatorVerdict(): SimulationVerdict {
    if (this.#simulatorVerdict === undefined) {
      throw new Error(
        'simulatorVerdict is only available inside onSimulationEnd (after the simulation completes)',
      );
    }
    return this.#simulatorVerdict;
  }

  /** The `JobContext` for this run; use it to reach the running session and
   * the room. */
  get jobContext(): JobContext {
    return this.#jobCtx;
  }

  /** @internal Populate the simulator verdict / run before `onSimulationEnd`. */
  _beginFinalize(opts: {
    simulatorVerdict: SimulationVerdict;
    run?: SimulationRun;
    job?: SimulationRun_Job;
  }): void {
    this.#simulatorVerdict = opts.simulatorVerdict;
    this.#run = opts.run;
    this.#job = opts.job;
  }

  /** The scenario's `userdata` decoded from its JSON string (`{}` if empty). */
  userdata(): ScenarioUserdata {
    if (!this.scenario.userdata) {
      return {};
    }
    return JSON.parse(this.scenario.userdata) as ScenarioUserdata;
  }

  /** Veto this run from your own checks (e.g. final DB state diverged).
   *
   * The effective result is the AND of both verdicts, so this can only fail a
   * run the simulator passed, never rescue one. The simulator's verdict is
   * still reported. The last call wins if you call {@link fail} more than once. */
  fail(reason = ''): void {
    this.#userVerdict = { success: false, reason };
  }

  /** Your veto set via {@link fail}, or undefined if you didn't veto the run. */
  get userVerdict(): SimulationVerdict | undefined {
    return this.#userVerdict;
  }
}
