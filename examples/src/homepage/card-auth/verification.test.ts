// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { beforeEach, describe, expect, it } from 'vitest';
import { Bank, FLAGGED, LOSS_PREVENTION_CASE, MAX_ATTEMPTS, addDays } from './bank.js';
import { CardServices, type Request, todayInBankTimezone } from './card_services.js';

const SAM = {
  fullName: 'Sam Ortiz',
  dateOfBirth: '1984-03-03',
  cardLastFour: '1111',
  request: 'other' as Request,
};

describe('card verification', () => {
  let published: Record<string, unknown>;
  let agent: CardServices;

  beforeEach(() => {
    published = {};
    const bank = new Bank(async (key, value) => {
      const historyKey = `${key}_history`;
      const history = (published[historyKey] as unknown[] | undefined) ?? [];
      history.push(value);
      published[historyKey] = history;
      published[key] = value;
    });
    agent = new CardServices(bank);
  });

  const verify = async (overrides: Partial<typeof SAM> = {}) =>
    JSON.parse(await agent.verifyIdentity({ ...SAM, ...overrides })) as Record<string, unknown>;

  it('any name and birthday with the demo card verify', async () => {
    expect(await verify()).toEqual({ verified: true });
    expect(published.status_history).toEqual(['authenticated']);
    expect(published.card).toMatchObject({ holder: 'Sam Ortiz' });
    expect(published.attempts).toEqual([
      {
        submitted: { name: 'Sam Ortiz', dateOfBirth: '1984-03-03', lastFour: '1111' },
        authenticated: true,
      },
    ]);
  });

  it.each(['0000', '4417', '1112'])('card %s fails without saying why', async (card) => {
    expect(await verify({ cardLastFour: card })).toEqual({ verified: false });
    expect(published.status).toBe('unauthenticated');
    expect(published).not.toHaveProperty('card');
  });

  it('three failed checks lock the caller out', async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS - 1; attempt++) {
      expect(await verify({ cardLastFour: '0000' })).toEqual({ verified: false });
    }
    expect(published).not.toHaveProperty('lockedOut');
    expect(await verify({ cardLastFour: '0000' })).toEqual({
      verified: false,
      locked_out: true,
    });
    expect(published.lockedOut).toBe(true);
    await expect(verify()).rejects.toBeInstanceOf(llm.ToolError);
  });

  it('nothing happens on the card before verification', async () => {
    await verify({ cardLastFour: '0000' });
    await expect(agent.lookUpRecentCharges()).rejects.toBeInstanceOf(llm.ToolError);
    await expect(agent.lockCard()).rejects.toBeInstanceOf(llm.ToolError);
    await expect(
      agent.setTravelNotice('Japan', addDays(todayInBankTimezone(), 10)),
    ).rejects.toBeInstanceOf(llm.ToolError);
    expect(published).not.toHaveProperty('card');
  });

  it('an unrecognized charge locks the card', async () => {
    await verify();
    const charge = JSON.parse(await agent.lookUpRecentCharges()) as {
      recent_charge: { where: string };
    };
    expect(charge.recent_charge.where).toBe(FLAGGED.place);
    expect(published.alert).toMatchObject({ madeByCardholder: null });

    const result = JSON.parse(await agent.reportPurchase(false)) as {
      loss_prevention_case: string;
    };
    expect(result.loss_prevention_case).toBe(LOSS_PREVENTION_CASE);
    expect(published.alert).toMatchObject({ madeByCardholder: false });
    expect(published.card).toMatchObject({
      state: 'locked',
      caseId: LOSS_PREVENTION_CASE,
    });
  });
});
