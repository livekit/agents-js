// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream as NodeReadableStream } from 'stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FunctionCall, ToolContext, ToolError, tool } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import type { Task } from '../utils.js';
import { cancelAndWait, delay } from '../utils.js';
import { AgentTask } from './agent.js';
import type { AgentSession } from './agent_session.js';
import {
  type _TextOut,
  _waitForToolExecutionResult,
  performTextForwarding,
  performToolExecutions,
} from './generation.js';
import type { SpeechHandle } from './speech_handle.js';
import { ToolExecutor } from './tool_executor.js';

function createStringStream(chunks: string[], delayMs: number = 0): NodeReadableStream<string> {
  return new NodeReadableStream<string>({
    async start(controller) {
      for (const c of chunks) {
        if (delayMs > 0) {
          await delay(delayMs);
        }
        controller.enqueue(c);
      }
      controller.close();
    },
  });
}

function createFunctionCallStream(fc: FunctionCall): NodeReadableStream<FunctionCall> {
  return new NodeReadableStream<FunctionCall>({
    start(controller) {
      controller.enqueue(fc);
      controller.close();
    },
  });
}

function createFunctionCallStreamFromArray(fcs: FunctionCall[]): NodeReadableStream<FunctionCall> {
  return new NodeReadableStream<FunctionCall>({
    start(controller) {
      for (const fc of fcs) {
        controller.enqueue(fc);
      }
      controller.close();
    },
  });
}

describe('Generation + Tool Execution', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not abort tool when preamble forwarders are cleaned up', async () => {
    vi.useFakeTimers();
    const replyAbortController = new AbortController();
    const forwarderController = new AbortController();

    const chunks = Array.from({ length: 50 }, () => `Hi.`);
    const fullPreambleText = chunks.join('');
    const preamble = createStringStream(chunks, 20);
    const [textForwardTask, textOut]: [Task<void>, _TextOut] = performTextForwarding(
      preamble,
      forwarderController,
      null,
    );

    // Tool that takes > 5 seconds
    let toolAborted = false;
    const getWeather = tool({
      name: 'getWeather',
      description: 'weather',
      parameters: z.object({ location: z.string() }),
      execute: async ({ location }, { abortSignal }) => {
        abortSignal.addEventListener('abort', () => {
          toolAborted = true;
        });
        // 6s delay
        await delay(6000);
        return `Sunny in ${location}`;
      },
    });

    const fc = FunctionCall.create({
      callId: 'call_1',
      name: 'getWeather',
      args: JSON.stringify({ location: 'San Francisco' }),
    });
    const toolCallStream = createFunctionCallStream(fc);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_test', _itemAdded: () => {} } as any,
      toolCtx: new ToolContext([getWeather]) as any,
      toolCallStream,
      controller: replyAbortController,
      onToolExecutionStarted: () => {},
      onToolExecutionCompleted: () => {},
    });

    // Ensure tool has started, then cancel forwarders mid-stream (without aborting parent AbortController)
    await toolOutput.firstToolStartedFuture.await;
    await vi.advanceTimersByTimeAsync(100);
    const cancelForwarder = cancelAndWait([textForwardTask], 5000);
    await vi.advanceTimersByTimeAsync(20);
    await cancelForwarder;

    await vi.advanceTimersByTimeAsync(6000);
    await execTask.result;

    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0]!;
    expect(out.toolCallOutput?.isError).toBe(false);
    expect(out.toolCallOutput?.output).toContain('Sunny in San Francisco');
    // Forwarder should have been cancelled before finishing all preamble chunks
    expect(textOut.text).not.toBe(fullPreambleText);
    // Tool's abort signal must not have fired
    expect(toolAborted).toBe(false);
  }, 30_000);

  it('should return basic tool execution output', async () => {
    const replyAbortController = new AbortController();

    const echo = tool({
      name: 'echo',
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => `echo: ${msg}`,
    });

    const fc = FunctionCall.create({
      callId: 'call_2',
      name: 'echo',
      args: JSON.stringify({ msg: 'hello' }),
    });
    const toolCallStream = createFunctionCallStream(fc);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_test2', _itemAdded: () => {} } as any,
      toolCtx: new ToolContext([echo]) as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await execTask.result;
    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0];
    expect(out?.toolCallOutput?.isError).toBe(false);
    expect(out?.toolCallOutput?.output).toContain('echo: hello');
  });

  it('should repair and canonicalize leaked template tokens in tool args', async () => {
    const replyAbortController = new AbortController();

    const removeOrderItem = tool({
      name: 'removeOrderItem',
      description: 'remove order item',
      parameters: z.object({ orderId: z.array(z.string()) }),
      execute: async ({ orderId }) => orderId.join(','),
    });

    const rawArgs = '{"orderId": ["<|\\"|\\"O_WAAB70<|\\"|\\"]}';
    const fc = FunctionCall.create({
      callId: 'call_repair_args',
      name: 'removeOrderItem',
      args: rawArgs,
    });
    const toolCallStream = createFunctionCallStream(fc);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as AgentSession,
      speechHandle: { id: 'speech_repair', _itemAdded: () => {} } as unknown as SpeechHandle,
      toolCtx: new ToolContext([removeOrderItem]) as unknown as ToolContext,
      toolCallStream,
      controller: replyAbortController,
    });

    await execTask.result;
    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0];
    expect(out?.toolCallOutput?.isError).toBe(false);
    expect(out?.toolCallOutput?.output).toBe('"O_WAAB70"');
    expect(fc.args).not.toBe(rawArgs);
    expect(JSON.parse(fc.args)).toEqual({ orderId: ['O_WAAB70'] });
  });

  it('should abort tool when reply is aborted mid-execution', async () => {
    const replyAbortController = new AbortController();

    let aborted = false;
    // Resolves once the tool body has begun and registered its abort listener. We cannot key off
    // `firstToolStartedFuture` here: that future now resolves right after argument parsing (before
    // execution), matching Python, so awaiting it does not guarantee the abort listener is wired.
    let signalToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });
    const longOp = tool({
      name: 'longOp',
      description: 'longOp',
      parameters: z.object({ ms: z.number() }),
      execute: async ({ ms }, { abortSignal }) => {
        abortSignal.addEventListener('abort', () => {
          aborted = true;
        });
        signalToolStarted();
        await delay(ms);
        return 'done';
      },
    });

    const fc = FunctionCall.create({
      callId: 'call_abort_1',
      name: 'longOp',
      args: JSON.stringify({ ms: 5000 }),
    });
    const toolCallStream = createFunctionCallStream(fc);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_abort', _itemAdded: () => {} } as any,
      toolCtx: new ToolContext([longOp]) as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await toolStarted;
    replyAbortController.abort();
    await execTask.result;

    expect(aborted).toBe(true);
    expect(toolOutput.output).toHaveLength(0);
  }, 20_000);

  it('keeps a settled tool result when abort is observed in the same tick', async () => {
    const replyAbortController = new AbortController();
    const settled = Promise.resolve('completed');
    replyAbortController.abort();

    await expect(
      _waitForToolExecutionResult(settled, replyAbortController.signal),
    ).resolves.toEqual({
      result: 'completed',
      isAborted: false,
    });
  });

  it('keeps completed output while omitting interrupted regular tools and handoffs', async () => {
    const replyAbortController = new AbortController();
    const neverFinish = new Promise<void>(() => {});
    let signalSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      signalSlowStarted = resolve;
    });
    let signalHandoffStarted!: () => void;
    const handoffStarted = new Promise<void>((resolve) => {
      signalHandoffStarted = resolve;
    });
    let signalCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      signalCompleted = resolve;
    });

    const immediate = tool({
      name: 'immediate',
      description: 'Completes before interruption.',
      parameters: z.object({}),
      execute: async () => 'completed',
    });
    const slow = tool({
      name: 'slow',
      description: 'Remains in flight during interruption.',
      parameters: z.object({}),
      execute: async () => {
        signalSlowStarted();
        await neverFinish;
        return 'unreachable';
      },
    });
    const handoff = tool({
      name: 'handoff',
      description: 'Returns a handoff only if allowed to finish.',
      parameters: z.object({}),
      execute: async () => {
        signalHandoffStarted();
        await neverFinish;
        return new AgentTask({ instructions: 'Handle the transferred request.' });
      },
    });
    const calls = [
      FunctionCall.create({ callId: 'call_completed', name: immediate.name, args: '{}' }),
      FunctionCall.create({ callId: 'call_slow', name: slow.name, args: '{}' }),
      FunctionCall.create({ callId: 'call_handoff', name: handoff.name, args: '{}' }),
    ];
    const completedCallIds: string[] = [];

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_mixed_abort', _itemAdded: () => {} } as any,
      toolCtx: new ToolContext([immediate, slow, handoff]) as any,
      toolCallStream: createFunctionCallStreamFromArray(calls),
      controller: replyAbortController,
      onToolExecutionCompleted: (output) => {
        completedCallIds.push(output.toolCall.callId);
        if (output.toolCall.callId === 'call_completed') signalCompleted();
      },
    });

    await Promise.all([completed, slowStarted, handoffStarted]);
    replyAbortController.abort();
    await execTask.result;

    expect(toolOutput.output.map((output) => output.toolCall.callId)).toEqual(['call_completed']);
    expect(completedCallIds).toEqual(['call_completed']);
  });

  it('resolves firstToolStartedFuture even when the only tool call is duplicate-rejected', async () => {
    const sharedExecutor = new ToolExecutor({ owningActivity: null });
    const session = { _activity: { _toolExecutor: sharedExecutor } } as unknown as AgentSession;
    const speechHandle = { id: 'speech_dup', _itemAdded: () => {} } as unknown as SpeechHandle;

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const slow = tool({
      name: 'slow',
      description: 'slow',
      onDuplicate: 'reject',
      parameters: z.object({}),
      execute: async () => {
        signalFirstStarted();
        await firstBlocked;
        return 'done';
      },
    });
    const toolCtx = new ToolContext([slow]) as unknown as ToolContext;

    // First call: starts and stays running so it occupies the executor's duplicate slot.
    const fc1 = FunctionCall.create({ callId: 'dup_c1', name: 'slow', args: '{}' });
    const [task1] = performToolExecutions({
      session,
      speechHandle,
      toolCtx,
      toolCallStream: createFunctionCallStream(fc1),
      controller: new AbortController(),
    });
    await firstStarted;

    // Second call: a duplicate of the still-running first call -> rejected by the executor.
    const fc2 = FunctionCall.create({ callId: 'dup_c2', name: 'slow', args: '{}' });
    const [task2, out2] = performToolExecutions({
      session,
      speechHandle,
      toolCtx,
      toolCallStream: createFunctionCallStream(fc2),
      controller: new AbortController(),
    });

    // Would hang forever before the fix.
    await out2.firstToolStartedFuture.await;
    await task2.result;

    // The duplicate produced a (rejection) output, and no real execution happened for it.
    expect(out2.output.length).toBe(1);

    releaseFirst();
    await task1.result;
  }, 20_000);

  it('should surface zod validation errors to the LLM with field-level detail', async () => {
    const replyAbortController = new AbortController();

    const echo = tool({
      name: 'echo',
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => `echo: ${msg}`,
    });

    // invalid: msg should be a string
    const fc = FunctionCall.create({
      callId: 'call_invalid_args',
      name: 'echo',
      args: JSON.stringify({ msg: 123 }),
    });
    const toolCallStream = createFunctionCallStream(fc);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_invalid', _itemAdded: () => {} } as any,
      toolCtx: new ToolContext([echo]) as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await execTask.result;
    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0];
    expect(out?.toolCallOutput?.isError).toBe(true);
    // LLM must see enough detail (tool name + offending field) to self-correct,
    // not the masked generic message reserved for tool-runtime exceptions.
    const output = out?.toolCallOutput?.output ?? '';
    expect(output).toContain('Invalid arguments');
    expect(output).toContain('echo');
    expect(output).toContain('msg');
    expect(output).not.toContain('An internal error occurred');
  });

  it('should surface JSON parse errors to the LLM', async () => {
    const replyAbortController = new AbortController();

    const echo = tool({
      name: 'echo',
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => `echo: ${msg}`,
    });

    // unrepairable JSON: random text the repair pass can't recover
    const fc = FunctionCall.create({
      callId: 'call_invalid_json',
      name: 'echo',
      args: 'definitely not json',
    });
    const toolCallStream = createFunctionCallStream(fc);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_bad_json', _itemAdded: () => {} } as any,
      toolCtx: new ToolContext([echo]) as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await execTask.result;
    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0];
    expect(out?.toolCallOutput?.isError).toBe(true);
    const output = out?.toolCallOutput?.output ?? '';
    expect(output).toContain('Invalid arguments');
    expect(output).toContain('echo');
    expect(output).not.toContain('An internal error occurred');
  });

  it('should mask generic tool exceptions so internal details do not reach the LLM', async () => {
    const replyAbortController = new AbortController();

    // The tool throws a regular Error whose message contains internals (db URL,
    // credentials) we must NOT forward to the LLM (and from there to end users).
    const sensitive = tool({
      name: 'sensitive',
      description: 'sensitive',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('database connection failed: postgres://admin:hunter2@db.internal:5432');
      },
    });

    const fc = FunctionCall.create({
      callId: 'call_generic_error',
      name: 'sensitive',
      args: JSON.stringify({}),
    });
    const toolCallStream = createFunctionCallStream(fc);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_generic_err', _itemAdded: () => {} } as any,
      toolCtx: new ToolContext([sensitive]) as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await execTask.result;
    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0];
    expect(out?.toolCallOutput?.isError).toBe(true);
    const output = out?.toolCallOutput?.output ?? '';
    expect(output).toBe('An internal error occurred');
    expect(output).not.toContain('database');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('postgres');
    // Raw exception is still preserved server-side for observability.
    expect(out?.rawException?.message).toContain('hunter2');
  });

  it('should forward ToolError messages to the LLM verbatim (escape hatch)', async () => {
    const replyAbortController = new AbortController();

    // Tools that intend to give the LLM a corrective hint opt in by throwing
    // ToolError — its message is forwarded as-is.
    const checked = tool({
      name: 'checked',
      description: 'checked',
      parameters: z.object({ qty: z.number() }),
      execute: async ({ qty }) => {
        if (qty <= 0) {
          throw new ToolError('qty must be positive — try again with a value greater than 0');
        }
        return qty;
      },
    });

    const fc = FunctionCall.create({
      callId: 'call_tool_error',
      name: 'checked',
      args: JSON.stringify({ qty: -1 }),
    });
    const toolCallStream = createFunctionCallStream(fc);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_tool_error', _itemAdded: () => {} } as any,
      toolCtx: new ToolContext([checked]) as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await execTask.result;
    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0];
    expect(out?.toolCallOutput?.isError).toBe(true);
    expect(out?.toolCallOutput?.output).toBe(
      'qty must be positive — try again with a value greater than 0',
    );
  });

  it('should handle multiple tool calls within a single stream', async () => {
    const replyAbortController = new AbortController();

    const sum = tool({
      name: 'sum',
      description: 'sum',
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    });
    const upper = tool({
      name: 'upper',
      description: 'upper',
      parameters: z.object({ s: z.string() }),
      execute: async ({ s }) => s.toUpperCase(),
    });

    const fc1 = FunctionCall.create({
      callId: 'call_multi_1',
      name: 'sum',
      args: JSON.stringify({ a: 2, b: 3 }),
    });
    const fc2 = FunctionCall.create({
      callId: 'call_multi_2',
      name: 'upper',
      args: JSON.stringify({ s: 'hey' }),
    });
    const toolCallStream = createFunctionCallStreamFromArray([fc1, fc2]);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_multi', _itemAdded: () => {} } as any,
      toolCtx: new ToolContext([sum, upper]) as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await execTask.result;
    expect(toolOutput.output.length).toBe(2);

    // sort by callId to assert deterministically
    const sorted = [...toolOutput.output].sort((a, b) =>
      a.toolCall.callId.localeCompare(b.toolCall.callId),
    );

    expect(sorted[0]?.toolCall.name).toBe('sum');
    expect(sorted[0]?.toolCallOutput?.isError).toBe(false);
    expect(sorted[0]?.toolCallOutput?.output).toBe('5');
    expect(sorted[1]?.toolCall.name).toBe('upper');
    expect(sorted[1]?.toolCallOutput?.isError).toBe(false);
    expect(sorted[1]?.toolCallOutput?.output).toBe('"HEY"');
  });
});
