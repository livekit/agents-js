// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JobContext } from './job.js';

// The @livekit/protocol npm package ships livekit_agent_simulation_pb in its
// tarball but does not re-export it from the package root (and the exports map
// blocks subpath imports), so the dispatch types are declared locally and the
// protojson is decoded by hand. Swap for the generated classes once the
// protocol package exports them.

/** How the simulated user interacts with the agent.
 * Mirrors `livekit.SimulationMode`. */
export enum SimulationMode {
  UNSPECIFIED = 0,
  /** The simulator chats over text streams (no audio). */
  TEXT = 1,
  /** The simulator publishes/subscribes audio in the room. */
  AUDIO = 2,
}

/** Mirrors `livekit.Scenario`. */
export interface Scenario {
  label: string;
  instructions: string;
  agentExpectations: string;
  tags: Record<string, string>;
  userdata: string;
}

/** Mirrors `livekit.SimulationDispatch`. */
export interface SimulationDispatch {
  simulationRunId: string;
  jobId: string;
  scenario: Scenario;
  mode: SimulationMode;
}

/** A pass/fail verdict for a scenario, with a human-readable reason. */
export interface SimulationVerdict {
  success: boolean;
  reason: string;
}

/** Decoded form of a Scenario's `userdata` (arbitrary JSON). On the wire it is
 * a JSON-encoded string; in a scenarios.yaml it is written as a nested mapping. */
export type ScenarioUserdata = { [key: string]: unknown };

const MODE_NAMES: Record<string, SimulationMode> = {
  SIMULATION_MODE_UNSPECIFIED: SimulationMode.UNSPECIFIED,
  SIMULATION_MODE_TEXT: SimulationMode.TEXT,
  SIMULATION_MODE_AUDIO: SimulationMode.AUDIO,
};

type JsonObject = Record<string, unknown>;

const pick = (obj: JsonObject, camel: string, snake: string): unknown =>
  obj[camel] !== undefined ? obj[camel] : obj[snake];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Decode a protojson `SimulationDispatch`. Accepts camelCase or snake_case
 * keys and string or numeric enum values, ignoring unknown fields — matching
 * protobuf `json_format.Parse(..., ignore_unknown_fields=True)` semantics for
 * the fields this SDK consumes. Throws on malformed input. */
export function parseSimulationDispatch(raw: string): SimulationDispatch {
  const obj: unknown = JSON.parse(raw);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new TypeError('simulation dispatch is not a JSON object');
  }
  const root = obj as JsonObject;

  let mode = SimulationMode.UNSPECIFIED;
  const rawMode = root.mode;
  if (typeof rawMode === 'number' && rawMode in SimulationMode) {
    mode = rawMode as SimulationMode;
  } else if (typeof rawMode === 'string' && rawMode in MODE_NAMES) {
    mode = MODE_NAMES[rawMode]!;
  }

  const rawScenario = (root.scenario ?? {}) as JsonObject;
  const rawTags = rawScenario.tags;
  const tags: Record<string, string> = {};
  if (typeof rawTags === 'object' && rawTags !== null && !Array.isArray(rawTags)) {
    for (const [k, v] of Object.entries(rawTags)) {
      tags[k] = str(v);
    }
  }

  return {
    simulationRunId: str(pick(root, 'simulationRunId', 'simulation_run_id')),
    jobId: str(pick(root, 'jobId', 'job_id')),
    scenario: {
      label: str(rawScenario.label),
      instructions: str(rawScenario.instructions),
      agentExpectations: str(pick(rawScenario, 'agentExpectations', 'agent_expectations')),
      tags,
      userdata: str(rawScenario.userdata),
    },
    mode,
  };
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
  #run?: { id: string };
  #simulatorVerdict?: SimulationVerdict;
  #userVerdict?: SimulationVerdict;

  constructor(dispatch: SimulationDispatch, jobCtx: JobContext) {
    this._dispatch = dispatch;
    this.#jobCtx = jobCtx;
  }

  get scenario(): Scenario {
    return this._dispatch.scenario;
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

  get simulationRun(): { id: string } | undefined {
    return this.#run;
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
  _beginFinalize(opts: { simulatorVerdict: SimulationVerdict; run?: { id: string } }): void {
    this.#simulatorVerdict = opts.simulatorVerdict;
    this.#run = opts.run;
  }

  /** The scenario's `userdata` decoded from its JSON string (`{}` if empty). */
  userdata(): ScenarioUserdata {
    if (!this._dispatch.scenario.userdata) {
      return {};
    }
    return JSON.parse(this._dispatch.scenario.userdata) as ScenarioUserdata;
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
