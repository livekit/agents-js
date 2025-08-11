// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '../llm/index.js';
import { Agent } from './agent.js';

describe('Agent', () => {
  it('should create agent with basic instructions', () => {
    const instructions = 'You are a helpful assistant';
    const agent = new Agent({ instructions });

    expect(agent).toBeDefined();
    expect(agent.instructions).toBe(instructions);
  });

  it('should create agent with instructions and tools', () => {
    const instructions = 'You are a helpful assistant with tools';

    // Create mock tools using the tool function
    const mockTool1 = tool({
      description: 'First test tool',
      parameters: z.object({}),
      execute: async () => 'tool1 result',
    });

    const mockTool2 = tool({
      description: 'Second test tool',
      parameters: z.object({
        input: z.string().describe('Input parameter'),
      }),
      execute: async ({ input }) => `tool2: ${input}`,
    });

    const agent = new Agent({
      instructions,
      tools: {
        getTool1: mockTool1,
        getTool2: mockTool2,
      },
    });

    expect(agent).toBeDefined();
    expect(agent.instructions).toBe(instructions);

    // Assert tools are set correctly
    const agentTools = agent.toolCtx;
    expect(Object.keys(agentTools)).toHaveLength(2);
    expect(agentTools).toHaveProperty('getTool1');
    expect(agentTools).toHaveProperty('getTool2');

    // Verify tool properties with proper checks
    expect(agentTools.getTool1?.description).toBe('First test tool');
    expect(agentTools.getTool2?.description).toBe('Second test tool');
  });

  it('should return a copy of tools, not the original reference', () => {
    const instructions = 'You are a helpful assistant';
    const mockTool = tool({
      description: 'Test tool',
      parameters: z.object({}),
      execute: async () => 'result',
    });

    const tools = { testTool: mockTool };
    const agent = new Agent({ instructions, tools });

    const tools1 = agent.toolCtx;
    const tools2 = agent.toolCtx;

    // Should return different object references
    expect(tools1).not.toBe(tools2);
    expect(tools1).not.toBe(tools);

    // Should contain the same set of tools
    expect(tools1).toEqual(tools2);
    expect(tools1).toEqual(tools);
  });
});
