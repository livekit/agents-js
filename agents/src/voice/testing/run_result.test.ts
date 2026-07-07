// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FunctionCall } from '../../llm/chat_context.js';
import { ToolContext, tool } from '../../llm/tool_context.js';
import { Agent } from '../agent.js';
import { performToolExecutions } from '../generation.js';
import { SpeechHandle } from '../speech_handle.js';
import { activeMockTools, getMockTool, mockTools, withMockTools } from './run_result.js';

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
      expect(activeMockTools).toBeDefined();
      expect(activeMockTools?.get(AgentA)?.tool1).toBe(mock);
    }

    expect(activeMockTools).toBeUndefined();
  });

  it('merges mocks across nested blocks and isolates per agent', () => {
    const mockA = () => 'a';
    const mockB = () => 'b';

    {
      using _mockA = withMockTools(AgentA, { toolA: mockA });
      {
        using _mockB = withMockTools(AgentB, { toolB: mockB });
        expect(activeMockTools?.get(AgentA)?.toolA).toBe(mockA);
        expect(activeMockTools?.get(AgentB)?.toolB).toBe(mockB);
      }

      expect(activeMockTools?.get(AgentA)?.toolA).toBe(mockA);
      expect(activeMockTools?.get(AgentB)).toBeUndefined();
    }
  });

  it('inner block for same agent overrides outer mocks', () => {
    const outer = () => 'outer';
    const inner = () => 'inner';

    {
      using _outer = withMockTools(AgentA, { tool1: outer });
      {
        using _inner = withMockTools(AgentA, { tool1: inner });
        expect(activeMockTools?.get(AgentA)?.tool1).toBe(inner);
      }
      expect(activeMockTools?.get(AgentA)?.tool1).toBe(outer);
    }
  });

  it('exposes the mock for invocation within the block', async () => {
    using _mock = withMockTools(AgentA, { tool1: async () => 42 });
    const mock = activeMockTools?.get(AgentA)?.tool1;
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
});

describe('mockTools (session-scoped)', () => {
  // mockTools only uses the session as a WeakMap key; a stub is sufficient,
  // matching the session stubs used by the performToolExecutions tests above.
  const makeSession = () => ({ currentAgent: undefined }) as never;

  it('registers mocks for a session and resolves them via getMockTool', () => {
    const session = makeSession();
    const agent = new AgentA();
    const mock = () => 'session-mocked';

    mockTools(AgentA, { tool1: mock }, session);

    expect(getMockTool(agent, 'tool1', session)).toBe(mock);
    // without the session, session-scoped mocks are invisible
    expect(getMockTool(agent, 'tool1')).toBeUndefined();
  });

  it('isolates mock sets per session', () => {
    const sessionA = makeSession();
    const sessionB = makeSession();
    const agent = new AgentA();

    mockTools(AgentA, { tool1: () => 'a' }, sessionA);

    expect(getMockTool(agent, 'tool1', sessionA)).toBeDefined();
    expect(getMockTool(agent, 'tool1', sessionB)).toBeUndefined();
  });

  it('replaces the mock set on re-registration and removes it with an empty record', () => {
    const session = makeSession();
    const agent = new AgentA();
    const second = () => 'second';

    mockTools(AgentA, { tool1: () => 'first' }, session);
    mockTools(AgentA, { tool2: second }, session);

    // full replacement: tool1 is gone, tool2 is present
    expect(getMockTool(agent, 'tool1', session)).toBeUndefined();
    expect(getMockTool(agent, 'tool2', session)).toBe(second);

    mockTools(AgentA, {}, session);
    expect(getMockTool(agent, 'tool2', session)).toBeUndefined();
  });

  it('context-scoped mocks take precedence over session-scoped ones', () => {
    const session = makeSession();
    const agent = new AgentA();
    const sessionMock = () => 'session';
    const contextMock = () => 'context';

    mockTools(AgentA, { tool1: sessionMock }, session);

    {
      using _mock = withMockTools(AgentA, { tool1: contextMock });
      expect(getMockTool(agent, 'tool1', session)).toBe(contextMock);
    }

    // context scope ended: session mocks apply again
    expect(getMockTool(agent, 'tool1', session)).toBe(sessionMock);
  });

  it('falls through to session mocks for tools the context set does not cover', () => {
    const session = makeSession();
    const agent = new AgentA();
    const sessionMock = () => 'session';

    mockTools(AgentA, { getWeather: sessionMock }, session);

    {
      // context mocks a *different* tool of the same agent type — the
      // session-scoped mock for getWeather must remain active
      using _mock = withMockTools(AgentA, { orderItem: () => 'ordered' });
      expect(getMockTool(agent, 'getWeather', session)).toBe(sessionMock);
      expect(getMockTool(agent, 'orderItem', session)).toBeDefined();
    }
  });

  it('routes performToolExecutions to a session-scoped mock', async () => {
    let realCalled = false;
    const realTool = tool({
      name: 'greet',
      description: 'real',
      parameters: z.object({ name: z.string() }),
      execute: async () => {
        realCalled = true;
        return 'real';
      },
    });
    const toolCtx = new ToolContext([realTool]);
    const speechHandle = SpeechHandle.create({ allowInterruptions: false });
    const session = { currentAgent: new AgentA() } as never;

    mockTools(AgentA, { greet: () => 'session-mocked' }, session);

    const controller = new AbortController();
    const call = FunctionCall.create({
      callId: 'call_session_mock',
      name: 'greet',
      args: JSON.stringify({ name: 'world' }),
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
    expect(realCalled).toBe(false);
    expect(output.output[0]?.rawOutput).toBe('session-mocked');
  });
});
