// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { toPhonicToolDefinitions } from './realtime_model.js';

describe('toPhonicToolDefinitions', () => {
  it('converts function tools without exposing their executors', () => {
    const searchPizzaShopRecs = llm.tool({
      name: 'search_pizza_shop_recs',
      description: 'Search for pizza shop recommendations in a location.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string' },
        },
        required: ['location'],
        additionalProperties: false,
      },
      execute: async ({ location }) => location,
    });

    const definitions = toPhonicToolDefinitions(new llm.ToolContext([searchPizzaShopRecs]));

    expect(definitions).toEqual([
      {
        name: 'search_pizza_shop_recs',
        description: 'Search for pizza shop recommendations in a location.',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
          required: ['location'],
          additionalProperties: false,
        },
      },
    ]);
  });
});
