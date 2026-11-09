// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Grades a simulated call on final clinic state against the scenario's `expected` userdata.
 */
import type { SimulationContext } from '@livekit/agents';
import { type Appointment, Clinic, PATIENTS_ON_FILE } from './clinic.js';
import type { CallState } from './receptionist.js';

const states = new WeakMap<SimulationContext, CallState>();

export function setupSimulation(simulation: SimulationContext, state: CallState): void {
  states.set(simulation, state);
}

export function onSimulationEnd(simulation: SimulationContext): void {
  try {
    const expected = simulation.userdata().expected;
    if (!isRecord(expected)) return;
    const state = states.get(simulation);
    if (!state) throw new Error('simulation call state was not registered');
    const problems = grade(state, expected);
    if (problems.length) simulation.fail(problems.join('; '));
  } catch (error) {
    simulation.fail(`failed to grade call: ${error instanceof Error ? error.message : error}`);
  } finally {
    states.delete(simulation);
  }
}

export function grade(state: CallState, expected: Record<string, unknown>): string[] {
  const clinic = state.clinic;
  if (!clinic) throw new Error('call state has no clinic');
  const problems: string[] = [];
  const caller = state.caller;
  const patient = typeof expected.patient === 'string' ? expected.patient : undefined;
  if (patient && (!caller || caller.name.toLocaleLowerCase() !== patient.toLocaleLowerCase())) {
    problems.push(`verified ${caller?.name ?? 'nobody'}, expected ${patient}`);
  } else if (caller && typeof expected.born === 'string') {
    const chart = clinic.patients.get(caller.name);
    if (chart !== expected.born) {
      problems.push(`${caller.name}'s chart has birthday ${chart}, expected ${expected.born}`);
    }
  }

  if (Object.hasOwn(expected, 'new_patient')) {
    const registered = [...clinic.patients.keys()].filter((name) => !PATIENTS_ON_FILE.has(name));
    const wanted = expected.new_patient ? (patient ? [patient] : []) : [];
    if (registered.map(fold).join('\0') !== wanted.map(fold).join('\0')) {
      problems.push(
        `registered ${registered.join(', ') || 'nobody'}, expected ${wanted.join(', ') || 'nobody'}`,
      );
    }
  }

  const seeded = new Map(
    new Clinic(clinic.today).appointments.map((appointment) => [
      appointment.id,
      appointment.startsAt.getTime(),
    ]),
  );
  const added = clinic.appointments.filter((appointment) => !seeded.has(appointment.id));
  const moved = clinic.appointments.filter(
    (appointment) =>
      seeded.has(appointment.id) && appointment.startsAt.getTime() !== seeded.get(appointment.id),
  );
  for (const [key, appointments] of [
    ['booked', added],
    ['moved', moved],
  ] as const) {
    if (Object.hasOwn(expected, key)) {
      problems.push(...check(key, appointments, expected[key], patient));
    }
  }
  return problems;
}

function check(
  key: 'booked' | 'moved',
  appointments: Appointment[],
  wanted: unknown,
  patient?: string,
): string[] {
  if (wanted === false) {
    return appointments.length ? [`${key} an appointment it shouldn't have`] : [];
  }
  if (appointments.length !== 1) {
    return [`${key} ${appointments.length} appointments, expected one in the ${String(wanted)}`];
  }
  const appointment = appointments[0]!;
  if (patient && fold(appointment.patient) !== fold(patient)) {
    return [`${key} one for ${appointment.patient}, expected ${patient}`];
  }
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(appointment.startsAt),
  );
  const part = hour < 12 ? 'morning' : 'afternoon';
  return part === wanted ? [] : [`${key} one for the ${part}, expected the ${String(wanted)}`];
}

function fold(value: string): string {
  return value.toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
