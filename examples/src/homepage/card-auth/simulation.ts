// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SimulationContext } from '@livekit/agents';
import { z } from 'zod';
import { type Bank, type DateOnly, daysBetween } from './bank.js';
import { todayInBankTimezone } from './card_services.js';

const banks = new WeakMap<SimulationContext, Bank>();

const expectedSchema = z.object({
  verified: z.boolean().optional(),
  failed_checks: z.number().optional(),
  locked_out: z.boolean().optional(),
  card: z.enum(['active', 'locked']).optional(),
  case: z.boolean().optional(),
  made_purchase: z.boolean().optional(),
  travel_to: z.string().optional(),
  back_in_days: z.union([z.number(), z.array(z.number())]).optional(),
});

export type ExpectedState = z.infer<typeof expectedSchema>;

export function setupSimulation(simulation: SimulationContext, bank: Bank): void {
  banks.set(simulation, bank);
}

export function onSimulationEnd(simulation: SimulationContext): void {
  try {
    const raw = simulation.userdata().expected;
    if (!raw) return;
    const bank = banks.get(simulation);
    if (!bank) throw new Error('simulation bank was not registered');
    const problems = grade(bank, expectedSchema.parse(raw), todayInBankTimezone());
    if (problems.length > 0) simulation.fail(problems.join('; '));
  } catch (error) {
    simulation.fail(
      `failed to grade card state: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    banks.delete(simulation);
  }
}

export function grade(bank: Bank, expected: ExpectedState, today: DateOnly): string[] {
  const problems: string[] = [];
  if (expected.verified !== undefined && bank.verified !== expected.verified) {
    problems.push(bank.verified ? 'ended verified' : 'never verified the caller');
  }
  const failed = bank.attempts.filter((attempt) => !attempt.authenticated).length;
  if (expected.failed_checks !== undefined && failed !== expected.failed_checks) {
    problems.push(`${failed} failed checks, expected ${expected.failed_checks}`);
  }
  if (expected.locked_out !== undefined && bank.lockedOut !== expected.locked_out) {
    problems.push(bank.lockedOut ? 'locked the caller out' : 'never locked the caller out');
  }

  if (expected.card && bank.card.state !== expected.card) {
    problems.push(`the card is ${bank.card.state}, expected ${expected.card}`);
  }
  if (expected.case !== undefined && (bank.card.caseId !== null) !== expected.case) {
    problems.push(
      bank.card.caseId ? 'opened a loss prevention case' : 'never opened a loss prevention case',
    );
  }
  if (expected.made_purchase !== undefined) {
    const said = bank.alert?.madeByCardholder ?? null;
    if (said !== expected.made_purchase) {
      problems.push(`recorded made_purchase ${said}, expected ${expected.made_purchase}`);
    }
  }

  if (expected.travel_to) {
    const travel = bank.card.travel;
    if (!travel || !travel.destination.toLowerCase().includes(expected.travel_to.toLowerCase())) {
      problems.push(
        `travel notice for ${travel?.destination ?? null}, expected ${expected.travel_to}`,
      );
    } else if (expected.back_in_days !== undefined) {
      const days = daysBetween(today, travel.until);
      const allowed = Array.isArray(expected.back_in_days)
        ? expected.back_in_days
        : [expected.back_in_days];
      if (!allowed.includes(days)) {
        problems.push(`the travel notice runs ${days} days, expected ${allowed.join(' or ')}`);
      }
    }
  }
  return problems;
}
