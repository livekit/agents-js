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
import { RunResult, activeMockTools, withMockTools } from './run_result.js';

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

describe('RunResult speech handle error propagation', () => {
  it('rejects when the last SpeechHandle completed with an error', async () => {
    const run = new RunResult();
    const handle = SpeechHandle.create();
    run._watchHandle(handle);

    const error = new Error('update_chat_ctx failed unexpectedly');
    handle._markDone(error);
    run._markDoneIfNeeded(handle);

    await expect(run.wait()).rejects.toThrow('update_chat_ctx failed unexpectedly');
  });

  it('resolves when the last SpeechHandle completed without an error', async () => {
    const run = new RunResult();
    const handle = SpeechHandle.create();
    run._watchHandle(handle);

    handle._markDone();
    run._markDoneIfNeeded(handle);

    await expect(run.wait()).resolves.toBe(run);
  });
});
