// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AlwaysOffSampler,
  InMemorySpanExporter,
  type ReadableSpan,
  type Sampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import { ToolContext, ToolError, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { genAI, inputDelta, setTracerProvider, traceTypes } from '../telemetry/index.js';
import { isFlushSentinel } from '../types.js';
import { type ModelSettings, StopResponse } from './agent.js';
import type { AgentSession } from './agent_session.js';
import {
  type _LLMGenerationData,
  performLLMInference,
  performToolExecutions,
} from './generation.js';
import type { LLMNode } from './io.js';
import type { SpeechHandle } from './speech_handle.js';

function setupInMemoryTracing(sampler?: Sampler) {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    sampler,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  setTracerProvider(provider);
  return { exporter, provider };
}

function spanByName(spans: ReadableSpan[], name: string) {
  return spans.find((s) => s.name === name);
}

function forbidContentBuilders(): void {
  const unexpectedBuilder = () => {
    throw new Error('content payload builder was called');
  };
  vi.spyOn(inputDelta.InputDelta.prototype, 'systemInstructions').mockImplementation(
    unexpectedBuilder,
  );
  vi.spyOn(inputDelta.InputDelta.prototype, 'inputMessages').mockImplementation(unexpectedBuilder);
  vi.spyOn(genAI, 'toOutputMessages').mockImplementation(unexpectedBuilder);
  vi.spyOn(genAI, 'toToolDefinitions').mockImplementation(unexpectedBuilder);
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

  const originalCaptureContent = genAI.captureContentEnabled();
  let provider: NodeTracerProvider;

  afterEach(async () => {
    genAI.setCaptureContent(originalCaptureContent);
    vi.restoreAllMocks();
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

    // this node produced the response itself, without an LLMStream, so there is no nested
    // `llm_request` span and the node span carries the convention's attributes
    expect(span.attributes['gen_ai.operation.name']).toBe('chat');
    expect(span.attributes['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    // the chat context is empty here, so only the output side has content to record
    expect(JSON.parse(span.attributes['gen_ai.output.messages'] as string)[0].parts).toEqual([
      { type: 'text', content: 'partial response' },
      expect.objectContaining({ type: 'tool_call', name: 'lookup_weather' }),
    ]);
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

  it('skips payload construction for a nonrecording span', async () => {
    const { provider: testProvider } = setupInMemoryTracing(new AlwaysOffSampler());
    provider = testProvider;
    genAI.setCaptureContent(true);
    forbidContentBuilders();
    const computeDelta = vi.spyOn(inputDelta, 'compute');
    const stringify = vi.spyOn(JSON, 'stringify');
    vi.spyOn(ChatContext.prototype, 'toJSON').mockImplementation(() => {
      throw new Error('chat context was serialized');
    });
    const llmNode: LLMNode = async () =>
      new ReadableStream<string | ChatChunk>({
        start(controller) {
          controller.enqueue('hello');
          controller.enqueue(createFunctionCallChunk());
          controller.close();
        },
      });

    const [task, data] = performLLMInference(
      llmNode,
      ChatContext.empty(),
      ToolContext.empty(),
      modelSettings,
      new AbortController(),
    );
    const [, drained] = await Promise.all([task.result, drainGenerationStreams(data)]);

    const serializedToolCalls = stringify.mock.calls.some(
      ([value]) => Array.isArray(value) && value[0]?.call_id === 'provider-call-id',
    );
    stringify.mockRestore();

    expect(drained.text).toBe('hello');
    expect(drained.toolCalls).toHaveLength(1);
    expect(computeDelta).not.toHaveBeenCalled();
    expect(serializedToolCalls).toBe(false);
  });

  it('preserves noncontent attributes when capture is disabled', async () => {
    const { exporter, provider: testProvider } = setupInMemoryTracing();
    provider = testProvider;
    forbidContentBuilders();
    genAI.setCaptureContent(false);
    const layout = vi.spyOn(genAI, 'messageLayout');
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'hello' });
    const llmNode: LLMNode = async () =>
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello');
          controller.close();
        },
      });

    const scope = new inputDelta.InputDeltaTracker().begin();
    const [task, data] = inputDelta.runWithScope(scope, () =>
      performLLMInference(
        llmNode,
        chatCtx,
        ToolContext.empty(),
        modelSettings,
        new AbortController(),
      ),
    );
    await Promise.all([task.result, drainGenerationStreams(data)]);

    expect(layout).not.toHaveBeenCalled();
    const span = spanByName(exporter.getFinishedSpans(), 'llm_node');
    expect(span?.attributes[traceTypes.ATTR_CHAT_CTX]).toBeDefined();
    expect(span?.attributes[traceTypes.ATTR_GEN_AI_OPERATION_NAME]).toBe('chat');
    expect(span?.attributes[traceTypes.ATTR_GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(span?.attributes[traceTypes.ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
  });
});

describe('performToolExecutions span telemetry', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  let provider: NodeTracerProvider;

  afterEach(async () => {
    await provider?.shutdown();
  });

  it.each([
    { label: 'StopResponse', exception: () => new StopResponse(), isError: false },
    { label: 'ToolError', exception: () => new ToolError('out of stock'), isError: true },
  ])('records the output of a tool that raised $label', async ({ exception, isError }) => {
    const { exporter, provider: testProvider } = setupInMemoryTracing();
    provider = testProvider;

    const lookup = tool({
      name: 'lookup',
      description: 'Look something up.',
      execute: async () => {
        throw exception();
      },
    });
    const [execTask, toolOutput] = performToolExecutions({
      session: {} as AgentSession,
      speechHandle: { id: 'speech_test', _itemAdded: () => {} } as unknown as SpeechHandle,
      toolCtx: new ToolContext([lookup]),
      toolCallStream: new ReadableStream({
        start(controller) {
          controller.enqueue(FunctionCall.create({ callId: 'call_1', name: 'lookup', args: '{}' }));
          controller.close();
        },
      }),
      controller: new AbortController(),
    });
    await execTask.result;

    expect(toolOutput.output[0]?.toolCallOutput.isError).toBe(isError);
    const span = spanByName(exporter.getFinishedSpans(), 'function_tool');
    expect(span?.attributes[traceTypes.ATTR_FUNCTION_TOOL_IS_ERROR]).toBe(isError);
    expect(span?.attributes[traceTypes.ATTR_ERROR_TYPE]).toBe(isError ? 'tool_error' : undefined);
  });
});
