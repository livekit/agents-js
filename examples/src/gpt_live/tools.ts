// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { z } from 'zod';

const orders: Record<string, string> = {
  A1042: 'shipped, arriving Thursday',
  B2231: 'still being packed',
};

export const checkOrderStatus = llm.tool({
  name: 'checkOrderStatus',
  description: 'Check the delivery status of an order.',
  parameters: z.object({ orderId: z.string().describe('The order reference, such as A1042.') }),
  execute: async ({ orderId }) => {
    const status = orders[orderId.toUpperCase()];
    return status ? `Order ${orderId} is ${status}.` : `There is no order ${orderId}.`;
  },
});

export const lookupWeather = llm.tool({
  name: 'lookupWeather',
  description: 'Look up the current weather for a location.',
  parameters: z.object({ location: z.string().describe('The city or region to look up.') }),
  execute: async ({ location }) => `The weather in ${location} is 62 degrees and partly cloudy.`,
});

export const scheduleDelivery = llm.tool({
  name: 'scheduleDelivery',
  description: 'Book a delivery day for an order.',
  parameters: z.object({ orderId: z.string(), day: z.string() }),
  execute: async ({ orderId, day }) =>
    orders[orderId.toUpperCase()]
      ? `Delivery for order ${orderId} is booked for ${day}.`
      : `I cannot find order ${orderId}, so I did not schedule anything.`,
});
