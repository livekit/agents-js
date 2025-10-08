// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream as NodeReadableStream } from 'stream/web';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FunctionCall, tool } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import type { Task } from '../utils.js';
import { cancelAndWait, delay } from '../utils.js';
import { type _TextOut, performTextForwarding, performToolExecutions } from './generation.js';

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

  it('should not abort tool when preamble forwarders are cleaned up', async () => {
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
      description: 'weather',
      parameters: z.object({ location: z.string() }),
      execute: async ({ location }, { abortSignal }) => {
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            toolAborted = true;
          });
        }
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
      toolCtx: { getWeather } as any,
      toolCallStream,
      controller: replyAbortController,
      onToolExecutionStarted: () => {},
      onToolExecutionCompleted: () => {},
    });

    // Ensure tool has started, then cancel forwarders mid-stream (without aborting parent AbortController)
    await toolOutput.firstToolStartedFuture.await;
    await delay(100);
    await cancelAndWait([textForwardTask], 5000);

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
      toolCtx: { echo } as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await execTask.result;
    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0];
    expect(out?.toolCallOutput?.isError).toBe(false);
    expect(out?.toolCallOutput?.output).toContain('echo: hello');
  });

  it('should abort tool when reply is aborted mid-execution', async () => {
    const replyAbortController = new AbortController();

    let aborted = false;
    const longOp = tool({
      description: 'longOp',
      parameters: z.object({ ms: z.number() }),
      execute: async ({ ms }, { abortSignal }) => {
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            aborted = true;
          });
        }
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
      toolCtx: { longOp } as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await toolOutput.firstToolStartedFuture.await;
    replyAbortController.abort();
    await execTask.result;

    expect(aborted).toBe(true);
    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0];
    expect(out?.toolCallOutput?.isError).toBe(true);
  }, 20_000);

  it('should return error output on invalid tool args (zod validation failure)', async () => {
    const replyAbortController = new AbortController();

    const echo = tool({
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => `echo: ${msg}`,
    });

    // invalid: msg should be string
    const fc = FunctionCall.create({
      callId: 'call_invalid_args',
      name: 'echo',
      args: JSON.stringify({ msg: 123 }),
    });
    const toolCallStream = createFunctionCallStream(fc);

    const [execTask, toolOutput] = performToolExecutions({
      session: {} as any,
      speechHandle: { id: 'speech_invalid', _itemAdded: () => {} } as any,
      toolCtx: { echo } as any,
      toolCallStream,
      controller: replyAbortController,
    });

    await execTask.result;
    expect(toolOutput.output.length).toBe(1);
    const out = toolOutput.output[0];
    expect(out?.toolCallOutput?.isError).toBe(true);
  });

  it('should handle multiple tool calls within a single stream', async () => {
    const replyAbortController = new AbortController();

    const sum = tool({
      description: 'sum',
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    });
    const upper = tool({
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
      toolCtx: { sum, upper } as any,
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
