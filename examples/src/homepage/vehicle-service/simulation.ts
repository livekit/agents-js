// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SimulationContext, voice } from '@livekit/agents';
import type { ServiceDesk } from './service_desk.js';

const ON_FILE = 'RO-48194';
const sessions = new WeakMap<SimulationContext, voice.AgentSession<ServiceDesk>>();
export function setupSimulation(
  simulation: SimulationContext,
  session: voice.AgentSession<ServiceDesk>,
): void {
  sessions.set(simulation, session);
}

export function onSimulationEnd(simulation: SimulationContext): void {
  try {
    const expected = simulation.userdata().expected;
    if (!expected || typeof expected !== 'object') return;
    const session = sessions.get(simulation);
    if (!session) throw new Error('simulation session was not registered');
    const problems = grade(session.userData, expected as Record<string, unknown>);
    if (problems.length) simulation.fail(problems.join('; '));
  } catch (error) {
    simulation.fail(
      `failed to grade the service desk: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    sessions.delete(simulation);
  }
}

export function grade(desk: ServiceDesk, expected: Record<string, unknown>): string[] {
  return desk.shop ? gradeCallback(desk, expected) : gradeInbound(desk, expected);
}
function gradeInbound(desk: ServiceDesk, expected: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const booked = desk.visit.booked?.status === 'booked' ? desk.visit.booked : undefined;
  const onFile = desk.appointments.find((a) => a.id === ON_FILE)!;
  const became = onFile.status === 'cancelled' ? 'cancelled' : onFile.movedFrom ? 'moved' : 'kept';
  const wanted = expected.on_file ?? 'kept';
  if (became !== wanted) problems.push(`the appointment on file was ${became}, expected ${wanted}`);
  if (expected.new_file && !desk.customer?.newFile) problems.push('never opened a new file');
  if (expected.mileage !== undefined && desk.visit.vehicle?.miles !== expected.mileage)
    problems.push(`mileage ${desk.visit.vehicle?.miles}, expected ${expected.mileage}`);
  if (Object.hasOwn(expected, 'booked') && Boolean(booked) !== expected.booked)
    problems.push(booked ? 'booked a visit' : 'never booked the visit');
  if (!booked) return problems;
  if (expected.vehicle && booked.vehicle.model !== expected.vehicle)
    problems.push(`booked the ${booked.vehicle.model}, expected the ${expected.vehicle}`);
  if (
    Array.isArray(expected.services) &&
    JSON.stringify([...booked.services].sort()) !== JSON.stringify([...expected.services].sort())
  )
    problems.push(
      `services ${JSON.stringify(booked.services)}, expected ${JSON.stringify(expected.services)}`,
    );
  if (expected.day && booked.slot.id.slice(0, 10) !== expected.day)
    problems.push(`booked ${booked.slot.id}, expected ${expected.day}`);
  if (expected.ride) {
    const rides = Array.isArray(expected.ride) ? expected.ride : [expected.ride];
    if (!rides.includes(booked.ride))
      problems.push(`ride ${booked.ride}, expected ${rides.join(' or ')}`);
  }
  if (expected.unsafe_to_drive && !booked.unsafe)
    problems.push('booked without the not-safe-to-drive flag');
  if (expected.approval_limit !== undefined && booked.approvalLimit !== expected.approval_limit)
    problems.push(`approval limit ${booked.approvalLimit}, expected ${expected.approval_limit}`);
  return problems;
}
function gradeCallback(desk: ServiceDesk, expected: Record<string, unknown>): string[] {
  const shop = desk.shop!;
  const problems: string[] = [];
  if (shop.endedEarly !== expected.ended_early)
    problems.push(`ended early as ${shop.endedEarly}, expected ${expected.ended_early}`);
  if (expected.decisions && typeof expected.decisions === 'object')
    for (const [repair, want] of Object.entries(expected.decisions)) {
      const got = shop.decisions[repair as keyof typeof shop.decisions];
      if (got !== want) problems.push(`${repair} ${got}, expected ${want}`);
    }
  if (expected.ride && shop.ride !== expected.ride)
    problems.push(`ride ${shop.ride}, expected ${expected.ride}`);
  if (expected.concern_noted && !shop.concerns.length) problems.push('never noted the new concern');
  return problems;
}
