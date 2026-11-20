// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import { Clinic } from './clinic.js';
import { type CallContext, ConfirmationCall, newCallState } from './receptionist.js';

const MONDAY = '2026-09-28';

describe('confirmation call', () => {
  let published: Record<string, unknown>;
  let clinic: Clinic;
  let agent: ConfirmationCall;
  let context: CallContext;

  beforeEach(() => {
    published = {};
    clinic = new Clinic(MONDAY, async (key, value) => {
      published[key] = value;
    });
    const appointment = clinic.appointments[0];
    if (!appointment) throw new Error('clinic seed requires an appointment');
    agent = new ConfirmationCall(clinic, appointment);
    context = { userData: newCallState() };
  });

  it('verifies any date of birth in the demo', async () => {
    const appointment = clinic.appointments[0]!;
    const verified = JSON.parse(await agent.verifyPatient(context, '2000-01-01')) as {
      verified: boolean;
    };
    expect(verified.verified).toBe(true);
    expect(context.userData.caller?.name).toBe(appointment.patient);
    expect(published.caller).toEqual({ name: appointment.patient, new: false });
  });
});
