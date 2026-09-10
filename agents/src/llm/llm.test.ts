// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AlwaysOffSampler,
  InMemorySpanExporter,
  type Sampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import type { LLMMetrics } from '../metrics/base.js';
import { genAI, setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Future, Task, delay } from '../utils.js';
import { ChatContext, FunctionCall } from './chat_context.js';
import { type ChatChunk, LLM, LLMStream } from './llm.js';
import type { ToolChoice, ToolCtxInput } from './tool_context.js';

class MockLLMStream extends LLMStream {
  constructor(
    llm: LLM,
    opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolCtxInput;
      connOptions: APIConnectOptions;
    },
    private chunks: ChatChunk[],
  ) {
    super(llm, opts);
  }

  protected async run(): Promise<void> {
    for (const chunk of this.chunks) {
      this.queue.put(chunk);
      await delay(1);
    }
  }
}

class MockLLM extends LLM {
  constructor(private chunks: ChatChunk[]) {
    super();
  }

  label(): string {
    return 'mock-llm';
  }

  chat(opts: {
    chatCtx: ChatContext;
    toolCtx?: ToolCtxInput;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    return new MockLLMStream(
      this,
      {
        chatCtx: opts.chatCtx,
        toolCtx: opts.toolCtx,
        connOptions: opts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      },
      this.chunks,
    );
  }
}

class PrewarmLLM extends MockLLM {
  constructor(private readonly prewarmImpl: (signal: AbortSignal) => Promise<void>) {
    super([]);
  }

  protected override _prewarmImpl(signal: AbortSignal): Promise<void> {
    return this.prewarmImpl(signal);
  }
}

class CaptureToggleLLMStream extends LLMStream {
  constructor(
    llm: LLM,
    opts: {
      chatCtx: ChatContext;
      connOptions: APIConnectOptions;
    },
    private captureContentDuringRun: boolean,
  ) {
    super(llm, opts);
  }

  protected async run(): Promise<void> {
    genAI.setCaptureContent(this.captureContentDuringRun);
    this.queue.put({ id: 'request-id', delta: { role: 'assistant', content: 'hello' } });
  }
}

const waitForTasks = () => new Promise<void>((resolve) => setImmediate(resolve));
const originalTracerProvider = tracer.getProvider();
let testTracerProvider: NodeTracerProvider | undefined;

function setupTracing(sampler?: Sampler): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  testTracerProvider = new NodeTracerProvider({
    sampler,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  setTracerProvider(testTracerProvider);
  return exporter;
}

function forbidContentBuilders(): void {
  const unexpectedBuilder = () => {
    throw new Error('content payload builder was called');
  };
  vi.spyOn(genAI, 'toSystemInstructions').mockImplementation(unexpectedBuilder);
  vi.spyOn(genAI, 'toInputMessages').mockImplementation(unexpectedBuilder);
  vi.spyOn(genAI, 'toOutputMessages').mockImplementation(unexpectedBuilder);
  vi.spyOn(genAI, 'toToolDefinitions').mockImplementation(unexpectedBuilder);
}

afterEach(async () => {
  genAI.setCaptureContent(true);
  vi.restoreAllMocks();
  setTracerProvider(originalTracerProvider);
  await testTracerProvider?.shutdown();
  testTracerProvider = undefined;
});

async function collectMetrics(llm: MockLLM): Promise<LLMMetrics> {
  const metrics = new Promise<LLMMetrics>((resolve) => llm.once('metrics_collected', resolve));
  await llm.chat({ chatCtx: new ChatContext() }).collect();
  return metrics;
}

describe('LLMStream metrics', () => {
  it('defaults cache creation tokens to zero', async () => {
    const metrics = await collectMetrics(new MockLLM([]));

    expect(metrics.cacheCreationTokens).toBe(0);
  });

  it('carries cache creation tokens', async () => {
    const metrics = await collectMetrics(
      new MockLLM([
        {
          id: '1',
          usage: {
            completionTokens: 10,
            promptTokens: 100,
            promptCachedTokens: 20,
            cacheCreationTokens: 42,
            totalTokens: 110,
          },
        },
      ]),
    );

    expect(metrics.cacheCreationTokens).toBe(42);
  });

  it('reports cached input tokens and content on the inference span', async () => {
    const exporter = setupTracing();
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'hello' });
    const llm = new MockLLM([
      { id: 'request-id', delta: { role: 'assistant', content: 'hello' } },
      {
        id: 'request-id',
        usage: {
          completionTokens: 20,
          promptTokens: 100,
          promptCachedTokens: 80,
          totalTokens: 120,
        },
      },
    ]);

    await llm.chat({ chatCtx }).collect();

    const span = exporter.getFinishedSpans().find(({ name }) => name === 'llm_request');
    expect(span?.attributes[traceTypes.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(80);
    expect(span?.attributes[traceTypes.ATTR_GEN_AI_USAGE_INPUT_CACHED_TOKENS]).toBe(80);
    expect(JSON.parse(span?.attributes[traceTypes.ATTR_GEN_AI_INPUT_MESSAGES] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
    ]);
    expect(JSON.parse(span?.attributes[traceTypes.ATTR_GEN_AI_OUTPUT_MESSAGES] as string)).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'hello' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it.each([
    { captureAtStart: false, captureDuringRun: true },
    { captureAtStart: true, captureDuringRun: false },
  ])(
    'requires capture at stream start and completion ($captureAtStart, $captureDuringRun)',
    async ({ captureAtStart, captureDuringRun }) => {
      const exporter = setupTracing();
      const chatCtx = ChatContext.empty();
      chatCtx.addMessage({ role: 'user', content: 'hello' });
      genAI.setCaptureContent(captureAtStart);

      const stream = new CaptureToggleLLMStream(
        new MockLLM([]),
        { chatCtx, connOptions: DEFAULT_API_CONNECT_OPTIONS },
        captureDuringRun,
      );
      const response = await stream.collect();

      expect(response.text).toBe('hello');
      const span = exporter.getFinishedSpans().find(({ name }) => name === 'llm_request');
      expect(traceTypes.ATTR_GEN_AI_INPUT_MESSAGES in (span?.attributes ?? {})).toBe(
        captureAtStart,
      );
      expect(traceTypes.ATTR_GEN_AI_OUTPUT_MESSAGES in (span?.attributes ?? {})).toBe(
        captureAtStart && captureDuringRun,
      );
    },
  );

  it('skips content builders and telemetry response accumulation when capture is disabled', async () => {
    const exporter = setupTracing();
    forbidContentBuilders();
    genAI.setCaptureContent(false);
    let conversions = 0;
    const content = {
      [Symbol.toPrimitive]() {
        conversions++;
        return 'hello';
      },
    } as unknown as string;
    const llm = new MockLLM([
      { id: 'request-id', delta: { role: 'assistant', content } },
      {
        id: 'request-id',
        usage: {
          completionTokens: 20,
          promptTokens: 100,
          promptCachedTokens: 80,
          totalTokens: 120,
        },
      },
    ]);

    const response = await llm.chat({ chatCtx: ChatContext.empty() }).collect();

    expect(conversions).toBe(1);
    expect(response.text).toBe('hello');
    expect(response.usage?.promptTokens).toBe(100);
    const span = exporter.getFinishedSpans().find(({ name }) => name === 'llm_request');
    expect(span?.attributes[traceTypes.ATTR_GEN_AI_REQUEST_MODEL]).toBe('unknown');
    expect(span?.attributes[traceTypes.ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
    expect(span?.attributes[traceTypes.ATTR_GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(span?.attributes[traceTypes.ATTR_GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
  });

  it('skips content builders and telemetry response accumulation for a nonrecording span', async () => {
    setupTracing(new AlwaysOffSampler());
    forbidContentBuilders();
    let conversions = 0;
    const content = {
      [Symbol.toPrimitive]() {
        conversions++;
        return 'hello';
      },
    } as unknown as string;
    const llm = new MockLLM([
      { id: 'request-id', delta: { role: 'assistant', content } },
      {
        id: 'request-id',
        usage: {
          completionTokens: 20,
          promptTokens: 100,
          promptCachedTokens: 80,
          totalTokens: 120,
        },
      },
    ]);

    const response = await llm.chat({ chatCtx: ChatContext.empty() }).collect();

    expect(conversions).toBe(1);
    expect(response.text).toBe('hello');
    expect(response.usage?.promptTokens).toBe(100);
  });
});

describe('LLM prewarm lifecycle', () => {
  it('is a no-op when the provider does not override _prewarmImpl', async () => {
    const taskFrom = vi.spyOn(Task, 'from');
    const llm = new MockLLM([]);

    try {
      llm.prewarm();
      await llm.aclose();

      expect(taskFrom).not.toHaveBeenCalled();
    } finally {
      taskFrom.mockRestore();
    }
  });

  it('schedules fire-and-forget work without surfacing provider rejection', async () => {
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    const llm = new PrewarmLLM(async () => {
      throw new Error('provider unavailable');
    });

    try {
      expect(() => llm.prewarm()).not.toThrow();
      await waitForTasks();

      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });

  it('invokes the provider hook once across repeated calls, including after failure', async () => {
    const prewarmImpl = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const llm = new PrewarmLLM(prewarmImpl);

    llm.prewarm();
    llm.prewarm();
    await waitForTasks();
    llm.prewarm();
    await waitForTasks();

    expect(prewarmImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight prewarm and waits for provider cleanup during close', async () => {
    const started = new Future<void>();
    let signal: AbortSignal | undefined;
    let cleanedUp = false;
    const llm = new PrewarmLLM(
      (prewarmSignal) =>
        new Promise<void>((resolve) => {
          signal = prewarmSignal;
          started.resolve();
          prewarmSignal.addEventListener(
            'abort',
            () => {
              setImmediate(() => {
                cleanedUp = true;
                resolve();
              });
            },
            { once: true },
          );
        }),
    );

    llm.prewarm();
    await started.await;
    const closing = llm.aclose();

    expect(signal?.aborted).toBe(true);
    expect(cleanedUp).toBe(false);

    await closing;
    expect(cleanedUp).toBe(true);
  });

  it('does not start prewarm work after close wins the lifecycle race', async () => {
    const prewarmImpl = vi.fn(async () => {});
    const llm = new PrewarmLLM(prewarmImpl);

    await llm.aclose();
    llm.prewarm();
    await waitForTasks();

    expect(prewarmImpl).not.toHaveBeenCalled();
  });
});

describe('LLMStream.collect', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    process.on('unhandledRejection', () => {});
  });

  it('joins content parts and trims surrounding whitespace', async () => {
    const llm = new MockLLM([
      { id: '1', delta: { role: 'assistant', content: '  Hello' } },
      { id: '1', delta: { role: 'assistant', content: ', ' } },
      { id: '1', delta: { role: 'assistant', content: 'world!  ' } },
    ]);

    const response = await llm.chat({ chatCtx: new ChatContext() }).collect();

    expect(response.text).toBe('Hello, world!');
    expect(response.toolCalls).toHaveLength(0);
    expect(response.usage).toBeUndefined();
    expect(response.extra).toEqual({});
  });

  it('accumulates tool calls across chunks', async () => {
    const callA = new FunctionCall({
      callId: 'call_a',
      name: 'get_weather',
      args: '{"city":"SF"}',
    });
    const callB = new FunctionCall({
      callId: 'call_b',
      name: 'play_song',
      args: '{"name":"x"}',
    });
    const llm = new MockLLM([
      { id: '1', delta: { role: 'assistant', toolCalls: [callA] } },
      { id: '1', delta: { role: 'assistant', toolCalls: [callB] } },
    ]);

    const response = await llm.chat({ chatCtx: new ChatContext() }).collect();

    expect(response.text).toBe('');
    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls[0]!.callId).toBe('call_a');
    expect(response.toolCalls[1]!.callId).toBe('call_b');
  });

  it('captures the latest usage and merges extra data', async () => {
    const llm = new MockLLM([
      { id: '1', delta: { role: 'assistant', content: 'hi', extra: { a: 1 } } },
      {
        id: '1',
        delta: { role: 'assistant', content: ' there', extra: { b: 2 } },
        usage: {
          completionTokens: 2,
          promptTokens: 5,
          promptCachedTokens: 0,
          totalTokens: 7,
        },
      },
      {
        id: '1',
        usage: {
          completionTokens: 3,
          promptTokens: 5,
          promptCachedTokens: 0,
          totalTokens: 8,
        },
      },
    ]);

    const response = await llm.chat({ chatCtx: new ChatContext() }).collect();

    expect(response.text).toBe('hi there');
    expect(response.usage?.completionTokens).toBe(3);
    expect(response.usage?.totalTokens).toBe(8);
    expect(response.extra).toEqual({ a: 1, b: 2 });
  });

  it('returns empty response for an empty stream', async () => {
    const llm = new MockLLM([]);

    const response = await llm.chat({ chatCtx: new ChatContext() }).collect();

    expect(response.text).toBe('');
    expect(response.toolCalls).toHaveLength(0);
    expect(response.usage).toBeUndefined();
    expect(response.extra).toEqual({});
  });
});
