// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FunctionCall } from '../../llm/chat_context.js';
import { ToolContext, tool } from '../../llm/tool_context.js';
import { Future } from '../../utils.js';
import { Agent } from '../agent.js';
import { performToolExecutions } from '../generation.js';
import { SpeechHandle } from '../speech_handle.js';
import { getActiveMockTools, getMockTool, withMockTools } from './run_result.js';

class AgentA extends Agent {
  constructor() {
    super({ instructions: 'a' });
  }
}

class AgentB extends Agent {
  constructor() {
    super({ instructions: 'b' });
  }
}

describe('withMockTools', () => {
  it('sets the mock registry for the given agent inside the block', () => {
    const mock = () => 'mocked';

    {
      using _mock = withMockTools(AgentA, { tool1: mock });
      expect(getActiveMockTools()).toBeDefined();
      expect(getActiveMockTools()?.get(AgentA)?.tool1).toBe(mock);
    }

    expect(getActiveMockTools()).toBeUndefined();
  });

  it('merges mocks across nested blocks and isolates per agent', () => {
    const mockA = () => 'a';
    const mockB = () => 'b';

    {
      using _mockA = withMockTools(AgentA, { toolA: mockA });
      {
        using _mockB = withMockTools(AgentB, { toolB: mockB });
        expect(getActiveMockTools()?.get(AgentA)?.toolA).toBe(mockA);
        expect(getActiveMockTools()?.get(AgentB)?.toolB).toBe(mockB);
      }

      expect(getActiveMockTools()?.get(AgentA)?.toolA).toBe(mockA);
      expect(getActiveMockTools()?.get(AgentB)).toBeUndefined();
    }
  });

  it('inner block for same agent overrides outer mocks', () => {
    const outer = () => 'outer';
    const inner = () => 'inner';

    {
      using _outer = withMockTools(AgentA, { tool1: outer });
      {
        using _inner = withMockTools(AgentA, { tool1: inner });
        expect(getActiveMockTools()?.get(AgentA)?.tool1).toBe(inner);
      }
      expect(getActiveMockTools()?.get(AgentA)?.tool1).toBe(outer);
    }
  });

  it('exposes the mock for invocation within the block', async () => {
    using _mock = withMockTools(AgentA, { tool1: async () => 42 });
    const mock = getActiveMockTools()?.get(AgentA)?.tool1;
    expect(await mock?.()).toBe(42);
  });

  it('routes performToolExecutions to the mock when set, original otherwise', async () => {
    let realCalled = false;
    const realTool = tool({
      name: 'greet',
      description: 'real',
      parameters: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        realCalled = true;
        return `real:${name}`;
      },
    });

    const toolCtx = new ToolContext([realTool]);
    const speechHandle = SpeechHandle.create({ allowInterruptions: false });
    const agent = new AgentA();

    // Minimal AgentSession stub: performToolExecutions only reads session.currentAgent.
    const session = { currentAgent: agent } as never;

    const makeStream = (call: FunctionCall) =>
      new ReadableStream<FunctionCall>({
        start(controller) {
          controller.enqueue(call);
          controller.close();
        },
      });

    // 1) With a mock registered: the mock runs, the real tool does not.
    {
      using _mock = withMockTools(AgentA, { greet: () => 'mocked' });
      const controller = new AbortController();
      const call = FunctionCall.create({
        callId: 'call_1',
        name: 'greet',
        args: JSON.stringify({ name: 'world' }),
      });
      const [task, output] = performToolExecutions({
        session,
        speechHandle,
        toolCtx,
        toolCallStream: makeStream(call),
        controller,
      });
      await task.result;
      expect(realCalled).toBe(false);
      expect(output.output[0]?.rawOutput).toBe('mocked');
    }

    // 2) Without a mock: the real tool runs.
    const controller = new AbortController();
    const call = FunctionCall.create({
      callId: 'call_2',
      name: 'greet',
      args: JSON.stringify({ name: 'world' }),
    });
    const [task, output] = performToolExecutions({
      session,
      speechHandle,
      toolCtx,
      toolCallStream: makeStream(call),
      controller,
    });
    await task.result;
    expect(realCalled).toBe(true);
    expect(output.output[0]?.rawOutput).toBe('real:world');
  });

  it('propagates thrown errors from mocks as tool errors', async () => {
    const realTool = tool({
      name: 'failing',
      description: 'real',
      parameters: z.object({}),
      execute: async () => 'ok',
    });
    const toolCtx = new ToolContext([realTool]);
    const speechHandle = SpeechHandle.create({ allowInterruptions: false });
    const session = { currentAgent: new AgentA() } as never;

    using _mock = withMockTools(AgentA, {
      failing: () => {
        throw new Error('test failure');
      },
    });
    const controller = new AbortController();
    const call = FunctionCall.create({
      callId: 'call_err',
      name: 'failing',
      args: '{}',
    });
    const stream = new ReadableStream<FunctionCall>({
      start(c) {
        c.enqueue(call);
        c.close();
      },
    });
    const [task, output] = performToolExecutions({
      session,
      speechHandle,
      toolCtx,
      toolCallStream: stream,
      controller,
    });
    await task.result;
    expect(output.output[0]?.rawException?.message).toBe('test failure');
    expect(output.output[0]?.toolCallOutput?.isError).toBe(true);
  });

  it('propagates the mock registry to child async tasks started within the block', async () => {
    const mock = () => 'child-visible';
    using _mock = withMockTools(AgentA, { tool1: mock });

    // A child async task started after withMockTools should inherit the registry.
    const childSaw = await (async () => {
      await Promise.resolve();
      return getActiveMockTools()?.get(AgentA)?.tool1;
    })();

    expect(childSaw).toBe(mock);
    expect(getMockTool(new AgentA(), 'tool1')).toBe(mock);
  });

  it('isolates mock registries across overlapping async contexts', async () => {
    const mockA = () => 'a';
    const mockB = () => 'b';

    const aEntered = new Future<void>();
    const bEntered = new Future<void>();

    // Scope A installs its mock first, then stays alive while scope B installs a
    // conflicting mock for the SAME agent/tool. With a module-level global, B would
    // clobber A's registry; with AsyncLocalStorage each scope keeps its own view.
    const scopeA = async () => {
      // Detach into this scope's own async context before installing the mock.
      await Promise.resolve();
      using _mockA = withMockTools(AgentA, { tool1: mockA });
      aEntered.resolve();
      await bEntered.await;
      expect(getActiveMockTools()?.get(AgentA)?.tool1).toBe(mockA);
      expect(getMockTool(new AgentA(), 'tool1')).toBe(mockA);
    };

    const scopeB = async () => {
      await aEntered.await;
      using _mockB = withMockTools(AgentA, { tool1: mockB });
      bEntered.resolve();
      await Promise.resolve();
      expect(getActiveMockTools()?.get(AgentA)?.tool1).toBe(mockB);
      expect(getMockTool(new AgentA(), 'tool1')).toBe(mockB);
    };

    await Promise.all([scopeA(), scopeB()]);

    // Both scopes have exited: nothing leaks into the outer context.
    expect(getActiveMockTools()).toBeUndefined();
  });
});
