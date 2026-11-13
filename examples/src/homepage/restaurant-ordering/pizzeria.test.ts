// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { type ItemSpec, Pizzeria, PizzeriaError } from './pizzeria.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions inspect JSON frontend payloads */

const SAM = { name: 'Sam Carter', phone: '4155550142' };
const item = (
  itemId: ItemSpec['itemId'],
  size?: ItemSpec['size'],
  quantity = 1,
  rest: Partial<ItemSpec> = {},
): ItemSpec => ({ itemId, size, quantity, ...rest });
async function order(...items: ItemSpec[]): Promise<Pizzeria> {
  const pos = new Pizzeria();
  const [, problems] = await pos.addItems(items);
  expect(problems).toEqual([]);
  await pos.setFulfillment('pickup');
  await pos.setContact(SAM.name, SAM.phone);
  return pos;
}

describe('Pizzeria', () => {
  it('the smoke order comes to its read-back total', async () => {
    const pos = await order(
      item('pepperoni', 'large'),
      item('wings', 'dozen', 1, { sauce: 'hot' }),
      item('coke', 'large'),
    );
    expect(pos.quote()!.total).toBe(4466);
    expect(pos.lines.map((line) => line.describe()).sort()).toEqual([
      '1 dozen Bone-in Wings, hot sauce',
      '1 large Coke',
      '1 large Pepperoni',
    ]);
  });

  it("what can't go on comes back with what to ask and the rest goes on", async () => {
    const pos = new Pizzeria();
    const [added, problems] = await pos.addItems([
      item('pepperoni', 'large'),
      item('coke'),
      item('wings', 'dozen'),
      item('buffalo_cauliflower'),
      item('fries', undefined, 1, { toppings: ['bacon'] }),
      item('veggie', 'large', 1, { without: ['ham'] }),
    ]);
    expect(added.map((line) => line.label)).toEqual(['large Pepperoni', 'dozen Bone-in Wings']);
    expect(problems.some((p) => p.includes('Ask which size Coke'))).toBe(true);
    expect(problems.some((p) => p.includes('sold out') && p.includes('Mozzarella Sticks'))).toBe(
      true,
    );
    expect(problems.some((p) => p.includes('Only pizzas'))).toBe(true);
    expect(problems.some((p) => p.includes("doesn't come with ham"))).toBe(true);
    expect(pos.lines.map((line) => line.id)).toEqual(['L1', 'L2']);
  });

  it('an order is placed only once it has everything', async () => {
    const pos = new Pizzeria();
    expect(() => pos.orderReadBack()).toThrow(PizzeriaError);
    await pos.addItems([item('pepperoni', 'large')]);
    await expect(pos.place()).rejects.toThrow('set_pickup or set_delivery');
    await pos.setFulfillment('pickup');
    await expect(pos.place()).rejects.toThrow('no name');
    await pos.setContact(SAM.name, SAM.phone);
    const readBack = pos.orderReadBack();
    expect(readBack.total).toBe('$21.79');
    expect(String(readBack.payment)).toMatch(/^Pay at pickup/);
    const placed = await pos.place();
    expect(placed.number).toBe('215');
    expect(placed.readyIn).toContain('20 minutes');
    await expect(pos.addItems([item('coke', 'large')])).rejects.toThrow('already sent');
  });

  it('swaps and takes off the Sprite and handles a changed mind', async () => {
    const pos = Pizzeria.outForDelivery('Sam Carter');
    await expect(pos.takeOffSoldOutItem()).resolves.toBe(435);
    expect(pos.balance()).toBe(-435);
    await pos.swapSoldOutItem('coke');
    expect(pos.balance()).toBe(0);
    expect(pos.soldOutUnresolved()).toBe(false);
    expect(pos.changes()).toEqual(['large Sprite swapped for a large Coke, same price']);
    await expect(pos.swapSoldOutItem('tiramisu')).rejects.toThrow('same price');
  });

  it('sends each page change in one update', async () => {
    const updates: Record<string, unknown>[] = [];
    const pos = Pizzeria.outForDelivery(null, async (parts) => {
      updates.push(parts);
    });
    await pos.publishAll();
    await pos.swapSoldOutItem('coke');
    expect(updates).toHaveLength(2);
    expect(Object.keys(updates[1]!).sort()).toEqual(['cart', 'delivery', 'fulfillment', 'quote']);
    const sent = { ...updates[0], ...updates[1] } as any;
    expect(Object.keys(sent).sort()).toEqual([
      'allergies',
      'cart',
      'delivery',
      'fulfillment',
      'menu',
      'order',
      'quote',
    ]);
    const [, wings, coke] = sent.cart.lines;
    expect(wings.size).toBe('12');
    expect(wings.modifiers).toEqual(['hot sauce']);
    expect(coke.was).toBe('Large Sprite');
    expect(coke.out).toBe(false);
    expect(sent.delivery.dueNow).toBe(49.65);
    expect(sent.delivery.changes).toEqual(['large Sprite swapped for a large Coke, same price']);
    await pos.cancel();
    expect((updates[2] as any).delivery.cancelled).toBe(true);
    expect((updates[2] as any).delivery.changes).toEqual([]);
  });
});
