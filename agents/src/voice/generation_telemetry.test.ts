// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import { ToolContext } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { setTracerProvider, traceTypes } from '../telemetry/index.js';
import { isFlushSentinel } from '../types.js';
import type { ModelSettings } from './agent.js';
import { type _LLMGenerationData, performLLMInference } from './generation.js';
import type { LLMNode } from './io.js';

function setupInMemoryTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  setTracerProvider(provider);
  return { exporter, provider };
}

function spanByName(spans: ReadableSpan[], name: string) {
  return spans.find((s) => s.name === name);
}

const modelSettings: ModelSettings = {};

function createFunctionCallChunk(): ChatChunk {
  return {
    id: 'chunk-1',
    delta: {
      role: 'assistant',
      toolCalls: [
        FunctionCall.create({
          callId: 'provider-call-id',
          name: 'lookup_weather',
          args: '{"city":"Paris"}',
        }),
      ],
    },
  };
}

async function drainGenerationStreams(data: _LLMGenerationData) {
  const textReader = data.textStream.getReader();
  const toolCallReader = data.toolCallStream.getReader();

  const textParts: string[] = [];
  const toolCalls: FunctionCall[] = [];

  await Promise.all([
    (async () => {
      while (true) {
        const { done, value } = await textReader.read();
        if (done) break;
        if (typeof value === 'string') {
          textParts.push(value);
        } else if (!isFlushSentinel(value)) {
          throw new Error(`unexpected text stream chunk: ${String(value)}`);
        }
      }
    })(),
    (async () => {
      while (true) {
        const { done, value } = await toolCallReader.read();
        if (done) break;
        toolCalls.push(value);
      }
    })(),
  ]);

  return { text: textParts.join(''), toolCalls };
}

function expectFunctionCallTelemetry(span: ReadableSpan) {
  expect(span.attributes[traceTypes.ATTR_RESPONSE_TEXT]).toBe('partial response');
  expect(span.attributes[traceTypes.ATTR_RESPONSE_TTFT]).toEqual(expect.any(Number));
  expect(span.attributes[traceTypes.ATTR_RESPONSE_FUNCTION_CALLS]).toBeDefined();
  expect(JSON.parse(String(span.attributes[traceTypes.ATTR_RESPONSE_FUNCTION_CALLS]))).toEqual([
    {
      id: expect.stringMatching(/\/fnc_0$/),
      call_id: 'provider-call-id',
      name: 'lookup_weather',
      arguments: '{"city":"Paris"}',
    },
  ]);
}

describe('performLLMInference response telemetry', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  let provider: NodeTracerProvider;

  afterEach(async () => {
    await provider?.shutdown();
  });

  it('records text, TTFT, and function calls on a completed stream', async () => {
    const { exporter, provider: testProvider } = setupInMemoryTracing();
    provider = testProvider;

    const llmNode: LLMNode = async () =>
      new ReadableStream<ChatChunk | string>({
        start(controller) {
          controller.enqueue('partial response');
          controller.enqueue(createFunctionCallChunk());
          controller.close();
        },
      });

    const controller = new AbortController();
    const [task, data] = performLLMInference(
      llmNode,
      ChatContext.empty(),
      ToolContext.empty(),
      modelSettings,
      controller,
    );

    const [, drained] = await Promise.all([task.result, drainGenerationStreams(data)]);

    expect(drained.text).toBe('partial response');
    expect(drained.toolCalls).toHaveLength(1);
    expect(drained.toolCalls[0]!.name).toBe('lookup_weather');

    const span = spanByName(exporter.getFinishedSpans(), 'llm_node');
    expect(span, 'llm_node span missing').toBeTruthy();
    if (!span) {
      throw new Error('expected llm_node span');
    }

    expectFunctionCallTelemetry(span);
  });

  it('records accumulated response telemetry when the stream aborts', async () => {
    const { exporter, provider: testProvider } = setupInMemoryTracing();
    provider = testProvider;

    const chunks: Array<string | ChatChunk> = ['partial response', createFunctionCallChunk()];
    let index = 0;

    const llmNode: LLMNode = async () =>
      new ReadableStream<ChatChunk | string>({
        pull(controller) {
          if (index < chunks.length) {
            controller.enqueue(chunks[index]!);
            index++;
            return;
          }
          controller.error(new DOMException('cancelled', 'AbortError'));
        },
      });

    const controller = new AbortController();
    const [task, data] = performLLMInference(
      llmNode,
      ChatContext.empty(),
      ToolContext.empty(),
      modelSettings,
      controller,
    );

    const textReader = data.textStream.getReader();
    const toolCallReader = data.toolCallStream.getReader();
    const taskErrorPromise = task.result.catch((error: unknown) => error);
    const [[textResult, toolCallResult], taskError] = await Promise.all([
      Promise.all([textReader.read(), toolCallReader.read()]),
      taskErrorPromise,
    ]);

    expect(taskError).toBeInstanceOf(DOMException);
    expect(taskError).toMatchObject({ name: 'AbortError', message: 'cancelled' });
    expect(textResult).toEqual({ done: false, value: 'partial response' });
    expect(toolCallResult.done).toBe(false);
    expect(toolCallResult.value?.name).toBe('lookup_weather');

    const span = spanByName(exporter.getFinishedSpans(), 'llm_node');
    expect(span, 'llm_node span missing').toBeTruthy();
    if (!span) {
      throw new Error('expected llm_node span');
    }

    expectFunctionCallTelemetry(span);
  });
});
