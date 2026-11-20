// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { ServiceDesk } from './service_desk.js';

const MONDAY = '2026-10-19';
async function alex(): Promise<ServiceDesk> {
  const desk = new ServiceDesk(MONDAY);
  await desk.findCustomer('Alex Morgan', '415-555-0142');
  return desk;
}
async function visitReadyToBook(desk: ServiceDesk): Promise<void> {
  await desk.chooseVehicle('V1');
  await desk.describeProblem({ summary: 'grinding from the front when braking' });
  await desk.addService('diagnostic');
  await desk.chooseTime('2026-10-21T07:30');
  await desk.chooseRide('shuttle');
}

describe('ServiceDesk', () => {
  test('a file opens only for its exact name and number', async () => {
    const desk = new ServiceDesk(MONDAY);
    expect(await desk.findCustomer('alex  morgan', '+1 (415) 555-0142')).toBeDefined();
    const other = new ServiceDesk(MONDAY);
    expect(await other.findCustomer('Alex Morgen', '4155550142')).toBeUndefined();
    expect(await other.findCustomer('Alex', '4155550142')).toBeUndefined();
    expect(other.customer).toBeUndefined();
  });
  test('a warranty repair needs a failed part, a problem, and warranty', async () => {
    const desk = await alex();
    await desk.chooseVehicle('V1');
    await expect(desk.addService('warranty_repair', 'liftgate_or_trunk')).rejects.toThrow(
      'Record the problem',
    );
    await desk.describeProblem({ summary: "liftgate won't close" });
    await expect(desk.addService('warranty_repair')).rejects.toThrow('failed_part');
    await desk.addService('warranty_repair', 'liftgate_or_trunk');
    expect(desk.visit.services).toEqual(['warranty_repair']);
    await desk.chooseTime('2026-10-21T07:30');
    await desk.chooseRide('wait');
    await desk.chooseVehicle('V2');
    expect(() => desk.readBack()).toThrow('out of warranty');
  });
  test('nothing reads back until the visit is complete', async () => {
    const desk = await alex();
    await desk.chooseVehicle('V1');
    expect(() => desk.readBack()).toThrow("a service, a time, how they'll get around");
  });
  test('a change after booking updates the same booking', async () => {
    const desk = await alex();
    await visitReadyToBook(desk);
    const first = await desk.book();
    expect(desk.changedSinceBooked()).toBe(false);
    await desk.addService('recall');
    expect(desk.changedSinceBooked()).toBe(true);
    const second = await desk.book();
    expect(second).toBe(first);
    expect(second.services).toEqual(['diagnostic', 'recall']);
    expect(desk.customerAppointments().filter((a) => a.status === 'booked')).toHaveLength(2);
  });
  test('the callback total and ready time follow the decisions', async () => {
    const desk = ServiceDesk.forCallback(MONDAY);
    expect(desk.totalDue()).toBe(159);
    await desk.decide('front_brakes', 'approved');
    expect(desk.totalDue()).toBe(159 + 489);
    expect(desk.pickupSummary().readyAt).toBe('today at 5:30 PM');
    await desk.decide('rear_brakes', 'approved');
    expect(desk.pickupSummary().readyAt).toBe('tomorrow at 10:00 AM');
    await expect(desk.endEarly('call_back_later')).rejects.toThrow('already decided');
  });
});
