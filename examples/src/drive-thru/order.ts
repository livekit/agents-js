// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ItemSize } from './database.js';

export function orderUid(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'O_';
  for (let i = 0; i < 6; i++) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return result;
}

export interface OrderedCombo {
  type: 'combo_meal';
  orderId: string;
  mealId: string;
  drinkId: string;
  drinkSize?: 'M' | 'L';
  friesSize: 'M' | 'L';
  sauceId?: string;
}

export interface OrderedHappy {
  type: 'happy_meal';
  orderId: string;
  mealId: string;
  drinkId: string;
  drinkSize?: ItemSize;
  sauceId?: string;
}

export interface OrderedRegular {
  type: 'regular';
  orderId: string;
  itemId: string;
  size?: ItemSize;
}

export type OrderedItem = OrderedCombo | OrderedHappy | OrderedRegular;

export class OrderState {
  items: Record<string, OrderedItem> = {};

  async add(item: OrderedItem): Promise<void> {
    this.items[item.orderId] = item;
  }

  async remove(orderId: string): Promise<OrderedItem> {
    const item = this.items[orderId];
    if (!item) {
      throw new Error(`Order item with ID ${orderId} not found`);
    }
    delete this.items[orderId];
    return item;
  }

  get(orderId: string): OrderedItem | undefined {
    return this.items[orderId];
  }
}

export function createOrderedCombo(params: {
  mealId: string;
  drinkId: string;
  drinkSize?: 'M' | 'L';
  friesSize: 'M' | 'L';
  sauceId?: string;
}): OrderedCombo {
  return {
    type: 'combo_meal',
    orderId: orderUid(),
    ...params,
  };
}

export function createOrderedHappy(params: {
  mealId: string;
  drinkId: string;
  drinkSize?: ItemSize;
  sauceId?: string;
}): OrderedHappy {
  return {
    type: 'happy_meal',
    orderId: orderUid(),
    ...params,
  };
}

export function createOrderedRegular(params: { itemId: string; size?: ItemSize }): OrderedRegular {
  return {
    type: 'regular',
    orderId: orderUid(),
    ...params,
  };
}
