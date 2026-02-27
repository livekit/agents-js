// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import { Task } from '../utils.js';
import { Agent, AgentTask, _setActivityTaskInfo } from './agent.js';
import { agentActivityStorage } from './agent_activity.js';

initializeLogger({ pretty: false, level: 'error' });

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

  it('should require AgentTask to run inside task context', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    await expect(task.run()).rejects.toThrow('must be executed inside a Task context');
  });

  it('should require AgentTask to run inside inline task context', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    const wrapper = Task.from(async () => {
      return await task.run();
    });

    await expect(wrapper.result).rejects.toThrow(
      'should only be awaited inside function tools or the onEnter/onExit methods of an Agent',
    );
  });

  it('should allow AgentTask run from inline task context', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    const oldAgent = new Agent({ instructions: 'old agent' });
    const mockSession = {
      currentAgent: oldAgent,
      _globalRunState: undefined,
      _updateActivity: async (agent: Agent) => {
        if (agent === task) {
          task.complete('ok');
        }
      },
    };

    const mockActivity = {
      agent: oldAgent,
      agentSession: mockSession,
      _onEnterTask: undefined,
      llm: undefined,
      close: async () => {},
    };

    const wrapper = Task.from(async () => {
      const currentTask = Task.current();
      if (!currentTask) {
        throw new Error('expected task context');
      }
      _setActivityTaskInfo(currentTask, { inlineTask: true });
      return await agentActivityStorage.run(mockActivity as any, () => task.run());
    });

    await expect(wrapper.result).resolves.toBe('ok');
  });

  it('should require AgentTask to run inside AgentActivity context', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    const wrapper = Task.from(async () => {
      const currentTask = Task.current();
      if (!currentTask) {
        throw new Error('expected task context');
      }
      _setActivityTaskInfo(currentTask, { inlineTask: true });
      return await task.run();
    });

    await expect(wrapper.result).rejects.toThrow(
      'must be executed inside an AgentActivity context',
    );
  });

  it('should close old activity when current agent changes while AgentTask is pending', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    const oldAgent = new Agent({ instructions: 'old agent' });
    const switchedAgent = new Agent({ instructions: 'switched agent' });
    const closeOldActivity = vi.fn(async () => {});

    const mockSession = {
      currentAgent: oldAgent as Agent,
      _globalRunState: undefined,
      _updateActivity: async (agent: Agent) => {
        if (agent === task) {
          mockSession.currentAgent = switchedAgent;
          task.complete('ok');
        }
      },
    };

    const mockActivity = {
      agent: oldAgent,
      agentSession: mockSession,
      _onEnterTask: undefined,
      llm: undefined,
      close: closeOldActivity,
    };

    const wrapper = Task.from(async () => {
      const currentTask = Task.current();
      if (!currentTask) {
        throw new Error('expected task context');
      }
      _setActivityTaskInfo(currentTask, { inlineTask: true });
      return await agentActivityStorage.run(mockActivity as any, () => task.run());
    });

    await expect(wrapper.result).resolves.toBe('ok');
    expect(closeOldActivity).toHaveBeenCalledTimes(1);
  });
});
