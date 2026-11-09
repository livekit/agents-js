// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SimulationContext } from '@livekit/agents';
import type { Pizzeria } from './pizzeria.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- scenario userdata is intentionally dynamic */

const sessions = new WeakMap<SimulationContext, Pizzeria>();
export function setupSimulation(sim: SimulationContext, pos: Pizzeria): void {
  sessions.set(sim, pos);
}
export function onSimulationEnd(sim: SimulationContext): void {
  const expected = sim.userdata().expected as Record<string, any> | undefined;
  if (!expected) return;
  const pos = sessions.get(sim);
  if (!pos) {
    sim.fail('simulation point of sale was not registered');
    return;
  }
  const problems = grade(pos, expected);
  if (problems.length) sim.fail(problems.join('; '));
  sessions.delete(sim);
}
export function grade(pos: Pizzeria, expected: Record<string, any>): string[] {
  const problems: string[] = [],
    lines = pos.lines.map((l) => l.describe()).sort(),
    order = pos.order,
    cancelled = !!order?.cancelled;
  if ('placed' in expected && !!order !== expected.placed)
    problems.push(
      order
        ? `order #${order.number} was placed`
        : `never placed (order: ${JSON.stringify(lines)})`,
    );
  if (expected.cart && JSON.stringify([...expected.cart].sort()) !== JSON.stringify(lines))
    problems.push(
      `order is ${JSON.stringify(lines)}, expected ${JSON.stringify([...expected.cart].sort())}`,
    );
  for (const want of expected.cart_includes ?? [])
    if (!lines.includes(want))
      problems.push(`${JSON.stringify(want)} isn't on the order (${JSON.stringify(lines)})`);
  for (const id of expected.not_in_cart ?? [])
    if (pos.lines.some((l) => l.item.id === id)) problems.push(`${id} is on the order`);
  if (expected.fulfillment && pos.fulfillment.mode !== expected.fulfillment)
    problems.push(`${pos.fulfillment.mode}, expected ${expected.fulfillment}`);
  if (expected.zip && pos.fulfillment.zipCode !== expected.zip)
    problems.push(`ZIP ${pos.fulfillment.zipCode}, expected ${expected.zip}`);
  if (expected.total != null && pos.quote()?.total !== Math.round(Number(expected.total) * 100))
    problems.push(`total ${pos.quote()?.total ?? null}, expected ${expected.total}`);
  if (expected.tip != null && pos.tip !== Math.round(Number(expected.tip) * 100))
    problems.push(`tip ${pos.tip}, expected ${expected.tip}`);
  for (const key of ['name', 'phone'] as const)
    if (expected[key] && pos[key] !== expected[key])
      problems.push(
        `${key} ${JSON.stringify(pos[key])}, expected ${JSON.stringify(expected[key])}`,
      );
  const note = (pos.fulfillment.driverNote ?? '').toLowerCase();
  for (const word of expected.driver_note ?? [])
    if (!note.includes(String(word).toLowerCase()))
      problems.push(
        `the driver note ${JSON.stringify(note)} doesn't mention ${JSON.stringify(word)}`,
      );
  for (const allergen of expected.allergies ?? [])
    if (!pos.allergies.has(allergen)) problems.push(`never looked up ${allergen}`);
  if ('cancelled' in expected && cancelled !== expected.cancelled)
    problems.push(cancelled ? 'cancelled the order' : 'never cancelled the order');
  const d = pos.delivery;
  if (d) {
    if (d.endedEarly !== (expected.ended_early ?? null))
      problems.push(`ended early as ${d.endedEarly}, expected ${expected.ended_early}`);
    if (!d.endedEarly && !cancelled) {
      if (pos.soldOutUnresolved())
        problems.push(`the ${pos.ranOutLine().label} is still on the order`);
      if (d.readBackRevision !== pos.revision) problems.push('the changes were never read back');
    }
    if (expected.unchanged && pos.changes().length)
      problems.push(`the order changed: ${JSON.stringify(pos.changes())}`);
    if (expected.balance != null && pos.balance() !== Math.round(Number(expected.balance) * 100))
      problems.push(`balance ${pos.balance()}, expected ${expected.balance}`);
  }
  return problems;
}
