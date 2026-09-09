// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream } from 'node:stream/web';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError } from '../_exceptions.js';
import type { LLMMetrics } from '../metrics/base.js';
import { ModelUsageCollector } from '../metrics/model_usage.js';
import { setTracerProvider, traceTypes } from '../telemetry/index.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Agent } from '../voice/agent.js';
import { AgentSession } from '../voice/agent_session.js';
import { performLLMInference } from '../voice/generation.js';
import { ChatContext } from './chat_context.js';
import { FallbackAdapter } from './fallback_adapter.js';
import { type ChatChunk, LLM, LLMStream } from './llm.js';
import { ToolContext } from './tool_context.js';

class TestLLM extends LLM {
  constructor(
    private modelName: string,
    private providerName: string,
    readonly fails = false,
  ) {
    super();
  }

  get model(): string {
    return this.modelName;
  }

  get provider(): string {
    return this.providerName;
  }

  label(): string {
    return `${this.provider}.LLM`;
  }

  chat(opts: Parameters<LLM['chat']>[0]): LLMStream {
    return new TestStream(this, {
      ...opts,
      connOptions: opts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}

class TestStream extends LLMStream {
  constructor(
    private llm: TestLLM,
    opts: ConstructorParameters<typeof LLMStream>[1],
  ) {
    super(llm, opts);
  }

  protected async run(): Promise<void> {
    if (this.llm.fails) throw new APIError('test provider unavailable');
    this.queue.put({
      id: this.llm.model,
      delta: { role: 'assistant', content: 'hello' },
      usage: { promptTokens: 10, promptCachedTokens: 0, completionTokens: 2, totalTokens: 12 },
    });
  }
}

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

describe('FallbackAdapter telemetry', () => {
  beforeAll(() => {
    provider.register();
    setTracerProvider(provider);
  });
  beforeEach(() => exporter.reset());
  afterAll(() => provider.shutdown());

  async function run(adapter: FallbackAdapter) {
    const metrics: LLMMetrics[] = [];
    const childMetrics: LLMMetrics[] = [];
    adapter.on('metrics_collected', (event) => metrics.push(event));
    for (const child of adapter.llms) {
      child.on('metrics_collected', (event) => childMetrics.push(event));
    }
    const chunks: ChatChunk[] = [];
    for await (const chunk of adapter.chat({ chatCtx: ChatContext.empty() })) chunks.push(chunk);
    await Promise.all(adapter._status.map((status) => status.recoveringTask));
    await provider.forceFlush();
    return { metrics, childMetrics, chunks };
  }

  it('reports only the primary model request and counts its tokens once', async () => {
    const primary = new TestLLM('primary-model', 'primary-provider');
    const backup = new TestLLM('backup-model', 'backup-provider');
    const { metrics, childMetrics, chunks } = await run(
      new FallbackAdapter({ llms: [primary, backup] }),
    );

    expect(chunks).toHaveLength(1);
    expect(metrics).toEqual(childMetrics);
    expect(metrics).toHaveLength(1);
    const usage = new ModelUsageCollector();
    metrics.forEach((event) => usage.collect(event));
    expect(usage.flatten()).toEqual([
      expect.objectContaining({
        model: 'primary-model',
        provider: 'primary-provider',
        inputTokens: 10,
        outputTokens: 2,
      }),
    ]);
  });

  it('keeps an orchestration span without reporting the adapter as an inference model', async () => {
    await run(new FallbackAdapter({ llms: [new TestLLM('primary-model', 'primary-provider')] }));
    const spans = exporter.getFinishedSpans();
    const requests = spans.filter((span) => span.name === 'llm_request');
    expect(requests.map((span) => span.attributes['gen_ai.request.model'])).toEqual([
      'primary-model',
    ]);
    const adapter = spans.find((span) => span.name === 'llm_fallback_adapter');
    expect(adapter).toBeDefined();
    expect(Object.keys(adapter!.attributes).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
    expect(adapter!.attributes[traceTypes.ATTR_LLM_METRICS]).toBeUndefined();
    const attempt = spans.find(
      (span) => span.spanContext().spanId === requests[0]!.parentSpanContext?.spanId,
    );
    expect(attempt!.parentSpanContext?.spanId).toBe(adapter!.spanContext().spanId);
    expect(requests[0]!.attributes['gen_ai.usage.input_tokens']).toBe(10);
    expect(requests[0]!.attributes['gen_ai.usage.output_tokens']).toBe(2);
  });

  it('preserves the real provider attribution after failover', async () => {
    const { metrics, childMetrics, chunks } = await run(
      new FallbackAdapter({
        llms: [
          new TestLLM('primary-model', 'primary-provider', true),
          new TestLLM('backup-model', 'backup-provider'),
        ],
      }),
    );
    expect(chunks.map((chunk) => chunk.id)).toEqual(['backup-model']);
    expect(metrics).toEqual(childMetrics);
    expect(metrics.filter((event) => event.totalTokens > 0)).toEqual([
      expect.objectContaining({
        metadata: { modelName: 'backup-model', modelProvider: 'backup-provider' },
        totalTokens: 12,
      }),
    ]);
    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === 'llm_request')
        .every((span) => span.attributes['gen_ai.request.model'] !== 'FallbackAdapter'),
    ).toBe(true);
  });

  it('does not multiply usage through nested fallback adapters', async () => {
    const child = new FallbackAdapter({ llms: [new TestLLM('primary-model', 'primary-provider')] });
    const { metrics, chunks } = await run(new FallbackAdapter({ llms: [child] }));
    expect(chunks).toHaveLength(1);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.metadata?.modelName).toBe('primary-model');
    expect(
      exporter.getFinishedSpans().filter((span) => span.name === 'llm_fallback_adapter'),
    ).toHaveLength(2);
  });

  it('ends the orchestration span and preserves the error when all providers fail', async () => {
    const adapter = new FallbackAdapter({
      llms: [new TestLLM('primary-model', 'primary-provider', true)],
    });
    const onError = vi.fn();
    adapter.on('error', onError);
    const { metrics, childMetrics, chunks } = await run(adapter);
    expect(chunks).toEqual([]);
    expect(metrics).toEqual(childMetrics);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(APIConnectionError), recoverable: false }),
    );
    expect(
      exporter.getFinishedSpans().filter((span) => span.name === 'llm_fallback_adapter'),
    ).toHaveLength(1);
  });

  it('ends the orchestration span when the consumer closes the stream', async () => {
    const adapter = new FallbackAdapter({
      llms: [new TestLLM('primary-model', 'primary-provider')],
    });
    const metrics: LLMMetrics[] = [];
    adapter.on('metrics_collected', (event) => metrics.push(event));
    const stream = adapter.chat({ chatCtx: ChatContext.empty() });
    stream.close();
    expect(await stream.next()).toMatchObject({ done: true });
    await vi.waitFor(() => {
      expect(
        exporter.getFinishedSpans().filter((span) => span.name === 'llm_fallback_adapter'),
      ).toHaveLength(1);
    });
    expect(metrics.every((event) => event.metadata?.modelName === 'primary-model')).toBe(true);
  });

  it.each([false, true])(
    'does not credit the configured wrapper on llm_node (failover=%s)',
    async (fails) => {
      const adapter = new FallbackAdapter({
        llms: [
          new TestLLM('primary-model', 'primary-provider', fails),
          new TestLLM('backup-model', 'backup-provider'),
        ],
      });
      const [task, data] = performLLMInference(
        async (chatCtx) => ReadableStream.from(adapter.chat({ chatCtx })),
        ChatContext.empty(),
        ToolContext.empty(),
        {},
        new AbortController(),
        adapter.model,
        adapter.provider,
      );
      const drain = async (stream: ReadableStream<unknown>) => {
        for await (const _ of stream) {
          /* consume */
        }
      };
      await Promise.all([task.result, drain(data.textStream), drain(data.toolCallStream)]);
      await Promise.all(adapter._status.map((status) => status.recoveringTask));
      const node = exporter.getFinishedSpans().find((span) => span.name === 'llm_node');
      expect(node).toBeDefined();
      expect(node!.attributes['gen_ai.request.model']).toBeUndefined();
      const request = exporter
        .getFinishedSpans()
        .find(
          (span) =>
            span.name === 'llm_request' && span.attributes['gen_ai.usage.output_tokens'] === 2,
        );
      expect(request!.attributes['gen_ai.request.model']).toBe(
        fails ? 'backup-model' : 'primary-model',
      );
    },
  );

  it('describes the configured primary model when starting an agent with nested adapters', async () => {
    const primary = new TestLLM('primary-model', 'primary-provider');
    const adapter = new FallbackAdapter({ llms: [new FallbackAdapter({ llms: [primary] })] });
    const session = new AgentSession({ llm: adapter, turnDetection: 'manual' });
    try {
      await session.start({ agent: new Agent({ instructions: 'test' }) });
      const start = exporter
        .getFinishedSpans()
        .find((span) => span.name === 'start_agent_activity');
      expect(start!.attributes['gen_ai.request.model']).toBe('primary-model');
      expect(start!.attributes['gen_ai.provider.name']).toBe('primary-provider');
    } finally {
      await session.close();
    }
  });
});
