// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type SimulationContext, voice } from '@livekit/agents';
import { z } from 'zod';
import type { UserData } from './drivethru_agent.js';
import type { OrderedItem } from './order.js';

const orderedItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('combo_meal'),
    mealId: z.string(),
    drinkId: z.string(),
    drinkSize: z.enum(['M', 'L']).optional(),
    friesSize: z.enum(['M', 'L']),
    sauceId: z.string().optional(),
  }),
  z.object({
    type: z.literal('happy_meal'),
    mealId: z.string(),
    drinkId: z.string(),
    drinkSize: z.enum(['S', 'M', 'L']).optional(),
    sauceId: z.string().optional(),
  }),
  z.object({
    type: z.literal('regular'),
    itemId: z.string(),
    size: z.enum(['S', 'M', 'L']).optional(),
  }),
]);

const sessions = new WeakMap<SimulationContext, voice.AgentSession<UserData>>();
const mocks = new WeakMap<SimulationContext, Disposable>();

export function setupSimulation(
  simulation: SimulationContext,
  session: voice.AgentSession<UserData>,
  agent: new (userdata: UserData) => voice.Agent<UserData>,
): void {
  const userdata = simulation.userdata();
  const unavailable = new Set(z.array(z.string()).parse(userdata.unavailableItems ?? []));
  for (const items of [
    session.userData.drinkItems,
    session.userData.comboItems,
    session.userData.happyItems,
    session.userData.regularItems,
    session.userData.sauceItems,
  ]) {
    for (const item of items) {
      if (unavailable.has(item.id)) item.available = false;
    }
  }

  const failingTools = z.array(z.string()).parse(userdata.failingTools ?? []);
  if (failingTools.length > 0) {
    mocks.set(
      simulation,
      voice.testing.withMockTools(
        agent,
        Object.fromEntries(
          failingTools.map((name) => [
            name,
            () => {
              throw new Error('simulated tool failure');
            },
          ]),
        ),
        { session },
      ),
    );
  }
  sessions.set(simulation, session);
}

export function onSimulationEnd(simulation: SimulationContext): void {
  try {
    const userdata = simulation.userdata();
    if (!Object.hasOwn(userdata, 'expectedOrder')) return;

    const session = sessions.get(simulation);
    if (!session) throw new Error('simulation session was not registered');

    const expected = canonical(z.array(orderedItemSchema).parse(userdata.expectedOrder));
    const actual = canonical(Object.values(session.userData.order.items));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      simulation.fail(
        `expected the order to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  } catch (error) {
    // A thrown callback is reported as an error and its verdict is dropped, so record it instead.
    simulation.fail(`failed to grade the order: ${error instanceof Error ? error.message : error}`);
  } finally {
    mocks.get(simulation)?.[Symbol.dispose]();
    mocks.delete(simulation);
    sessions.delete(simulation);
  }
}

function canonical(items: Iterable<Omit<OrderedItem, 'orderId'>>): string[] {
  return Array.from(items, (item) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(item)
          .filter(([key]) => key !== 'orderId')
          .sort(),
      ),
    ),
  ).sort();
}
