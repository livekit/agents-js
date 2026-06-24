// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FunctionCall } from '../../llm/chat_context.js';
import { ToolContext, tool } from '../../llm/tool_context.js';
import { initializeLogger } from '../../log.js';
import { Future } from '../../utils.js';
import { Agent } from '../agent.js';
import { AgentSession } from '../agent_session.js';
import { performToolExecutions } from '../generation.js';
import { SpeechHandle } from '../speech_handle.js';
import { FakeLLM } from './fake_llm.js';
import { getActiveMockTools, getMockTool, withMockTools } from './run_result.js';

initializeLogger({ pretty: false, level: 'silent' });

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

// Probes for the activity-loop tests below: which implementation actually executed.
let realToolRan = false;
let mockRan = false;

class ProbeAgent extends Agent {
  constructor() {
    super({
      instructions: 'You are a probe agent.',
      tools: [
        tool({
          name: 'theTool',
          description: 'A real tool whose execution we can detect.',
          parameters: z.object({}),
          execute: async () => {
            realToolRan = true;
            return 'REAL';
          },
        }),
      ],
    });
  }
}

function makeFakeLLM(): FakeLLM {
  return new FakeLLM([{ input: 'order', toolCalls: [{ name: 'theTool', args: {} }] }]);
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

describe('withMockTools reaches the agent-activity loop', () => {
  let session: AgentSession;

  beforeAll(async () => {
    // Start the activity loop in the setup async context, before any mock exists,
    // mirroring the real `session.start()` (e.g. drive-thru) usage pattern.
    session = new AgentSession({ llm: makeFakeLLM() });
    await session.start({ agent: new ProbeAgent() });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
  });

  it('routes the activity-loop tool execution to a mock installed in the test body', async () => {
    realToolRan = false;
    mockRan = false;

    using _mock = withMockTools(ProbeAgent, {
      theTool: () => {
        mockRan = true;
        return 'MOCKED';
      },
    });

    const result = session.run({ userInput: 'order' });
    await result.wait();

    result.expect.containsFunctionCall({ name: 'theTool' });
    expect(mockRan).toBe(true);
    expect(realToolRan).toBe(false);
    // The tool output is JSON-serialized, so the raw string 'MOCKED' surfaces as '"MOCKED"'.
    result.expect.containsFunctionCallOutput({ output: '"MOCKED"' });
  }, 30_000);

  it('executes the real tool when no mock is installed (harness sanity)', async () => {
    realToolRan = false;
    mockRan = false;

    const result = session.run({ userInput: 'order' });
    await result.wait();

    result.expect.containsFunctionCall({ name: 'theTool' });
    expect(realToolRan).toBe(true);
    expect(mockRan).toBe(false);
    result.expect.containsFunctionCallOutput({ output: '"REAL"' });
  }, 30_000);
});

describe('withMockTools caller-leak inside an async helper (known limitation)', () => {
  it('leaks the mock into the caller continuation after the using block', async () => {
    // No mock active at the outer scope.
    expect(getActiveMockTools()).toBeUndefined();

    async function helper(): Promise<void> {
      using _mock = withMockTools(ProbeAgent, { theTool: () => 'X' });
      // The mock is visible inside the helper.
      expect(getActiveMockTools()?.get(ProbeAgent)?.theTool).toBeDefined();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    await helper();

    // KNOWN LIMITATION: `withMockTools` uses `AsyncLocalStorage.enterWith`, which mutates the
    // caller's context synchronously; the `using` dispose runs in the helper's post-await child
    // context and restores that context rather than the caller's, so the caller still observes
    // the mock after `await helper()`. The canonical synchronous `using` usage in a test body is
    // unaffected. Flip these to `toBeUndefined()` if the leak is fixed (e.g. scope via
    // `mockToolsStorage.run(...)` instead of `enterWith`).
    expect(getActiveMockTools()).toBeDefined();
    expect(getActiveMockTools()?.get(ProbeAgent)?.theTool).toBeDefined();
  });
});
