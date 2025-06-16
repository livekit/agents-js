// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunContext } from '../voice/run_context.js';
import { type ToolExecutionOptions, tool } from './tool.js';

describe('tool', () => {
  it('should create and execute a basic core tool', async () => {
    const getWeather = tool({
      name: 'get-weather',
      description: 'Get the weather for a given location',
      parameters: z.object({
        location: z.string(),
      }),
      execute: async ({ location }, { ctx }: ToolExecutionOptions<{ name: string }>) => {
        return `The weather in ${location} is sunny, ${ctx.userData.name}`;
      },
    });

    const runContext = { userData: { name: 'John' } } as unknown as RunContext<{ name: string }>;
    const result = await getWeather.execute(
      { location: 'San Francisco' },
      { ctx: runContext, toolCallId: '123' },
    );
    expect(result).toBe('The weather in San Francisco is sunny, John');
  });
});
