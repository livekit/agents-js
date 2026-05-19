// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FunctionCall } from '../../llm/chat_context.js';
import { tool } from '../../llm/tool_context.js';
import { Agent } from '../agent.js';
import { performToolExecutions } from '../generation.js';
import { SpeechHandle } from '../speech_handle.js';
import { mockToolsStorage, withMockTools } from './run_result.js';

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
  it('sets the mock registry for the given agent inside the callback', async () => {
    const mock = () => 'mocked';

    await withMockTools(AgentA, { tool1: mock })(async () => {
      const store = mockToolsStorage.getStore();
      expect(store).toBeDefined();
      expect(store?.get(AgentA)?.tool1).toBe(mock);
    });

    expect(mockToolsStorage.getStore()).toBeUndefined();
  });

  it('merges mocks across nested calls and isolates per agent', async () => {
    const mockA = () => 'a';
    const mockB = () => 'b';

    await withMockTools(AgentA, { toolA: mockA })(async () => {
      await withMockTools(AgentB, { toolB: mockB })(async () => {
        const store = mockToolsStorage.getStore();
        expect(store?.get(AgentA)?.toolA).toBe(mockA);
        expect(store?.get(AgentB)?.toolB).toBe(mockB);
      });

      const store = mockToolsStorage.getStore();
      expect(store?.get(AgentA)?.toolA).toBe(mockA);
      expect(store?.get(AgentB)).toBeUndefined();
    });
  });

  it('inner call for same agent overrides outer mocks', async () => {
    const outer = () => 'outer';
    const inner = () => 'inner';

    await withMockTools(AgentA, { tool1: outer })(async () => {
      await withMockTools(AgentA, { tool1: inner })(async () => {
        expect(mockToolsStorage.getStore()?.get(AgentA)?.tool1).toBe(inner);
      });
      expect(mockToolsStorage.getStore()?.get(AgentA)?.tool1).toBe(outer);
    });
  });

  it('returns the callback value (including async results)', async () => {
    const result = await withMockTools(AgentA, { tool1: async () => 42 })(async () => {
      const mock = mockToolsStorage.getStore()?.get(AgentA)?.tool1;
      return await mock?.();
    });
    expect(result).toBe(42);
  });

  it('routes performToolExecutions to the mock when set, original otherwise', async () => {
    let realCalled = false;
    const realTool = tool({
      description: 'real',
      parameters: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        realCalled = true;
        return `real:${name}`;
      },
    });

    const toolCtx = { greet: realTool };
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
    await withMockTools(AgentA, { greet: () => 'mocked' })(async () => {
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
    });

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
      description: 'real',
      parameters: z.object({}),
      execute: async () => 'ok',
    });
    const toolCtx = { failing: realTool };
    const speechHandle = SpeechHandle.create({ allowInterruptions: false });
    const session = { currentAgent: new AgentA() } as never;

    await withMockTools(AgentA, {
      failing: () => {
        throw new Error('test failure');
      },
    })(async () => {
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
});
