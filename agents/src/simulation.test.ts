// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { JobContext } from './job.js';
import {
  ScenarioGroup,
  SimulationContext,
  SimulationMode,
  SimulationRun,
  SimulationRun_Job,
  parseSimulationDispatch,
} from './simulation.js';

const fakeJobCtx = {} as unknown as JobContext;

function dispatchJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    simulationRunId: 'SR_1',
    jobId: 'AJ_1',
    scenario: {
      label: 'refund flow',
      instructions: 'ask for a refund',
      agentExpectations: 'processes the refund',
      tags: { suite: 'billing' },
      userdata: '{"orderId": 42}',
    },
    mode: 'SIMULATION_MODE_AUDIO',
    ...overrides,
  });
}

describe('parseSimulationDispatch', () => {
  it('decodes protojson with camelCase keys and string enums', () => {
    const d = parseSimulationDispatch(dispatchJson());
    expect(d.simulationRunId).toBe('SR_1');
    expect(d.jobId).toBe('AJ_1');
    expect(d.scenario?.label).toBe('refund flow');
    expect(d.scenario?.agentExpectations).toBe('processes the refund');
    expect(d.scenario?.tags).toEqual({ suite: 'billing' });
    expect(d.mode).toBe(SimulationMode.AUDIO);
  });

  it('accepts snake_case keys and numeric enums (json_format.Parse parity)', () => {
    const raw = JSON.stringify({
      simulation_run_id: 'SR_2',
      job_id: 'AJ_2',
      scenario: { agent_expectations: 'x' },
      mode: 1,
    });
    const d = parseSimulationDispatch(raw);
    expect(d.simulationRunId).toBe('SR_2');
    expect(d.scenario?.agentExpectations).toBe('x');
    expect(d.mode).toBe(SimulationMode.TEXT);
  });

  it('defaults missing fields and ignores unknown fields', () => {
    const d = parseSimulationDispatch('{"simulationRunId":"SR_3","futureField":true}');
    expect(d.simulationRunId).toBe('SR_3');
    expect(d.jobId).toBe('');
    expect(d.scenario).toBeUndefined();
    expect(d.mode).toBe(SimulationMode.UNSPECIFIED);

    // SimulationContext papers over the unset message field.
    const ctx = new SimulationContext(d, fakeJobCtx);
    expect(ctx.scenario.label).toBe('');
    expect(ctx.scenario.tags).toEqual({});
    expect(ctx.userdata()).toEqual({});
  });

  it('throws on malformed JSON and non-object payloads', () => {
    expect(() => parseSimulationDispatch('{oops')).toThrow();
    expect(() => parseSimulationDispatch('[1,2]')).toThrow();
    expect(() => parseSimulationDispatch('"str"')).toThrow();
  });
});

describe('SimulationContext', () => {
  it('exports the generated scenario group, run, and job data models', () => {
    const job = new SimulationRun_Job({ id: 'AJ_1', label: 'refund flow' });
    const run = new SimulationRun({ id: 'SR_1', jobs: [job] });
    const group = new ScenarioGroup({ name: 'billing' });

    expect(run.jobs).toEqual([job]);
    expect(run.jobs[0]?.label).toBe('refund flow');
    expect(group.name).toBe('billing');
  });

  it('treats UNSPECIFIED mode as TEXT (pre-mode simulations were text-only)', () => {
    const d = parseSimulationDispatch(dispatchJson({ mode: undefined }));
    const ctx = new SimulationContext(d, fakeJobCtx);
    expect(ctx.simulationMode).toBe(SimulationMode.TEXT);
  });

  it('keeps explicit AUDIO mode', () => {
    const ctx = new SimulationContext(parseSimulationDispatch(dispatchJson()), fakeJobCtx);
    expect(ctx.simulationMode).toBe(SimulationMode.AUDIO);
  });

  it('decodes userdata and defaults to {}', () => {
    const ctx = new SimulationContext(parseSimulationDispatch(dispatchJson()), fakeJobCtx);
    expect(ctx.userdata()).toEqual({ orderId: 42 });

    const empty = new SimulationContext(
      parseSimulationDispatch(dispatchJson({ scenario: {} })),
      fakeJobCtx,
    );
    expect(empty.userdata()).toEqual({});
  });

  it('exposes scenario and jobContext', () => {
    const ctx = new SimulationContext(parseSimulationDispatch(dispatchJson()), fakeJobCtx);
    expect(ctx.scenario.instructions).toBe('ask for a refund');
    expect(ctx.jobContext).toBe(fakeJobCtx);
  });

  it('simulatorVerdict throws before finalize and reads after', () => {
    const ctx = new SimulationContext(parseSimulationDispatch(dispatchJson()), fakeJobCtx);
    expect(() => ctx.simulatorVerdict).toThrow(/onSimulationEnd/);
    const run = new SimulationRun({ id: 'SR_1' });
    const job = new SimulationRun_Job({ id: 'AJ_1' });
    ctx._beginFinalize({
      simulatorVerdict: { success: true, reason: 'looked good' },
      run,
      job,
    });
    expect(ctx.simulatorVerdict).toEqual({ success: true, reason: 'looked good' });
    expect(ctx.simulationRun).toBe(run);
    expect(ctx.simulationJob).toBe(job);
  });

  it('fail() records a veto; last call wins; no veto by default', () => {
    const ctx = new SimulationContext(parseSimulationDispatch(dispatchJson()), fakeJobCtx);
    expect(ctx.userVerdict).toBeUndefined();
    ctx.fail('db mismatch');
    ctx.fail('worse: db missing');
    expect(ctx.userVerdict).toEqual({ success: false, reason: 'worse: db missing' });
  });
});
