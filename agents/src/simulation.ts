// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JobContext } from './job.js';

export type ScenarioUserdata = Record<string, unknown>;

export type Scenario = {
  label?: string;
  instructions?: string;
  agentExpectations?: string;
  agent_expectations?: string;
  tags?: Record<string, string>;
  userdata?: string;
  [key: string]: unknown;
};

export type ScenarioGroup = {
  name?: string;
  scenarios?: Scenario[];
  [key: string]: unknown;
};

export type SimulationRun = {
  id?: string;
  [key: string]: unknown;
};

export type SimulationRunJob = {
  id?: string;
  [key: string]: unknown;
};

export type SimulationDispatch = {
  simulationRunId?: string;
  simulation_run_id?: string;
  jobId?: string;
  job_id?: string;
  scenario?: Scenario;
  [key: string]: unknown;
};

export class SimulationVerdict {
  success: boolean;
  reason: string;

  constructor(success: boolean, reason = '') {
    this.success = success;
    this.reason = reason;
  }
}

export class SimulationContext<ProcessUserData = Record<string, unknown>> {
  private readonly dispatch: SimulationDispatch;
  private readonly _scenario: Scenario;
  private readonly jobCtx: JobContext<ProcessUserData>;
  private _run?: SimulationRun;
  private _job?: SimulationRunJob;
  private _simulatorVerdict?: SimulationVerdict;
  private _userVerdict?: SimulationVerdict;

  /** @internal */
  constructor(dispatch: SimulationDispatch, jobCtx: JobContext<ProcessUserData>) {
    this.dispatch = dispatch;
    this._scenario = dispatch.scenario ?? {};
    this.jobCtx = jobCtx;
  }

  get scenario(): Scenario {
    return this._scenario;
  }

  get run(): SimulationRun | undefined {
    return this._run;
  }

  get job(): SimulationRunJob | undefined {
    return this._job;
  }

  get simulatorVerdict(): SimulationVerdict {
    if (!this._simulatorVerdict) {
      throw new Error(
        'simulatorVerdict is only available inside onSimulationEnd (after the simulation completes)',
      );
    }
    return this._simulatorVerdict;
  }

  get jobContext(): JobContext<ProcessUserData> {
    return this.jobCtx;
  }

  /** @internal */
  _beginFinalize({
    simulatorVerdict,
    run,
    job,
  }: {
    simulatorVerdict: SimulationVerdict;
    run?: SimulationRun;
    job?: SimulationRunJob;
  }): void {
    this._simulatorVerdict = simulatorVerdict;
    this._run = run;
    this._job = job;
  }

  userdata(): ScenarioUserdata {
    if (!this._scenario.userdata) {
      return {};
    }
    return JSON.parse(this._scenario.userdata) as ScenarioUserdata;
  }

  fail(reason = ''): void {
    this._userVerdict = new SimulationVerdict(false, reason);
  }

  get userVerdict(): SimulationVerdict | undefined {
    return this._userVerdict;
  }

  /** @internal */
  get simulationRunId(): string | undefined {
    return this.dispatch.simulationRunId ?? this.dispatch.simulation_run_id;
  }
}
