// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import { Clinic } from './clinic.js';
import { type CallContext, Receptionist, newCallState } from './receptionist.js';

const MONDAY = '2026-09-28';

describe('front desk verification', () => {
  let clinic: Clinic;
  let agent: Receptionist;
  let context: CallContext;

  beforeEach(() => {
    clinic = new Clinic(MONDAY);
    agent = new Receptionist(clinic);
    context = { userData: newCallState() };
  });

  it('locks the calendar until the caller is verified', async () => {
    await expect(agent.checkAvailability(context, '2026-10-05', '2026-10-05')).rejects.toThrow(
      /isn't verified/,
    );
  });

  it('finds the chart behind a misheard name after its spelling is corrected', async () => {
    const heard = JSON.parse(await agent.lookUpBirthday(context, '1992-07-08', 'Jordan Leigh')) as {
      charts: Array<{ name: string }>;
    };
    const spelled = JSON.parse(await agent.lookUpBirthday(context, '1992-07-08', 'Jordan Lee')) as {
      charts: Array<{ name: string }>;
    };

    expect(heard.charts).toEqual([]);
    expect(spelled.charts.map((chart) => chart.name)).toEqual(['Jordan Lee']);
  });

  it('opens only a chart on the looked-up birthday', async () => {
    await expect(agent.openChart(context, 'Taylor Smith')).rejects.toThrow(/date of birth first/);

    await agent.lookUpBirthday(context, '1992-07-08', 'Taylor Smith');
    await expect(agent.openChart(context, 'Taylor Smith')).rejects.toThrow(/No chart named/);

    await agent.lookUpBirthday(context, '1992-07-08', 'Jordan Smith');
    await expect(agent.openChart(context, 'Jordan Lee')).rejects.toThrow(/No chart named/);
    expect(context.userData.caller).toBeUndefined();
  });

  it('verifies a new patient once registered', async () => {
    await agent.lookUpBirthday(context, '1995-06-01', 'Casey Morgan');
    await agent.registerNewPatient(context, 'C A S E Y', 'M O R G A N');

    expect(context.userData.caller?.name).toBe('Casey Morgan');
    const [opening] = JSON.parse(
      await agent.checkAvailability(context, '2026-10-05', '2026-10-05'),
    ) as Array<{ starts_at: string }>;
    expect(opening).toBeDefined();
    await expect(
      agent.bookAppointment(context, opening!.starts_at, 'Sore throat'),
    ).resolves.toMatch(/^Booked Sore throat for/);
  });
});
