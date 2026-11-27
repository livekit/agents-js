// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { delay } from '../utils.js';
import type { ChatContext } from './chat_context.js';
import { FallbackAdapter } from './fallback_adapter.js';
import { type ChatChunk, LLM, LLMStream } from './llm.js';
import type { ToolChoice, ToolContextLike } from './tool_context.js';

class MockLLMStream extends LLMStream {
  public myLLM: LLM;

  constructor(
    llm: LLM,
    opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolContextLike;
      connOptions: APIConnectOptions;
    },
    private shouldFail: boolean = false,
    private failAfterChunks: number = 0,
    private chunk?: ChatChunk,
  ) {
    super(llm, opts);
    this.myLLM = llm;
  }

  protected async run(): Promise<void> {
    if (this.shouldFail && this.failAfterChunks === 0) {
      throw new APIError('Mock LLM failed immediately');
    }

    const chunk: ChatChunk = this.chunk ?? {
      id: 'test-id',
      delta: { role: 'assistant', content: 'chunk' },
    };

    for (let i = 0; i < 3; i++) {
      if (this.shouldFail && i === this.failAfterChunks) {
        throw new APIError('Mock LLM failed after chunks');
      }
      this.queue.put(chunk);
      await delay(10);
    }
  }
}

class MockLLM extends LLM {
  shouldFail: boolean = false;
  failAfterChunks: number = 0;
  chunk?: ChatChunk;
  private _label: string;

  constructor(label: string) {
    super();
    this._label = label;
  }

  label(): string {
    return this._label;
  }

  chat(opts: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
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
        connOptions: opts.connOptions!,
      },
      this.shouldFail,
      this.failAfterChunks,
      this.chunk,
    );
  }
}

describe('FallbackAdapter', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    // Suppress unhandled rejections from LLMStream background tasks
    process.on('unhandledRejection', () => {});
  });

  it('should initialize correctly', () => {
    const llm1 = new MockLLM('llm1');
    const adapter = new FallbackAdapter({ llms: [llm1] });
    expect(adapter.llms).toHaveLength(1);
    expect(adapter.llms[0]).toBe(llm1);
  });

  it('should throw if no LLMs provided', () => {
    expect(() => new FallbackAdapter({ llms: [] })).toThrow();
  });

  it('should use primary LLM if successful', async () => {
    const llm1 = new MockLLM('llm1');
    const llm2 = new MockLLM('llm2');
    const adapter = new FallbackAdapter({ llms: [llm1, llm2] });

    const stream = adapter.chat({
      chatCtx: {} as ChatContext,
    });

    const chunks: ChatChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    // Should verify it used llm1 (we can check logs or spy, but simple success is good first step)
  });

  it('should fallback to second LLM if first fails immediately', async () => {
    const llm1 = new MockLLM('llm1');
    llm1.shouldFail = true;
    const llm2 = new MockLLM('llm2');
    const adapter = new FallbackAdapter({ llms: [llm1, llm2] });

    const stream = adapter.chat({
      chatCtx: {} as ChatContext,
    });

    const chunks: ChatChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(adapter._status[0]!.available).toBe(false);
    expect(adapter._status[1]!.available).toBe(true);
  });

  it('should fail if all LLMs fail', async () => {
    const llm1 = new MockLLM('llm1');
    llm1.shouldFail = true;
    const llm2 = new MockLLM('llm2');
    llm2.shouldFail = true;
    const adapter = new FallbackAdapter({ llms: [llm1, llm2] });

    const stream = adapter.chat({
      chatCtx: {} as ChatContext,
    });

    const errorPromise = new Promise<Error>((resolve) => {
      adapter.on('error', (e) => resolve(e.error));
    });

    for await (const _ of stream) {
      // consume
    }

    const error = await errorPromise;
    expect(error).toBeInstanceOf(APIConnectionError);
  });

  it('should fail if chunks sent and retryOnChunkSent is false', async () => {
    const llm1 = new MockLLM('llm1');
    llm1.shouldFail = true;
    llm1.failAfterChunks = 1; // Fail after 1 chunk
    const llm2 = new MockLLM('llm2');
    const adapter = new FallbackAdapter({
      llms: [llm1, llm2],
      retryOnChunkSent: false,
    });

    const stream = adapter.chat({
      chatCtx: {} as ChatContext,
    });

    const errorPromise = new Promise<Error>((resolve) => {
      adapter.on('error', (e) => resolve(e.error));
    });

    for await (const _ of stream) {
      // consume
    }

    const error = await errorPromise;
    expect(error).toBeInstanceOf(APIError);
  });

  it('should fallback if chunks sent and retryOnChunkSent is true', async () => {
    const llm1 = new MockLLM('llm1');
    llm1.shouldFail = true;
    llm1.failAfterChunks = 1;
    const llm2 = new MockLLM('llm2');
    const adapter = new FallbackAdapter({
      llms: [llm1, llm2],
      retryOnChunkSent: true,
    });

    const stream = adapter.chat({
      chatCtx: {} as ChatContext,
    });

    const chunks: ChatChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    // 1 chunk from failed llm1 + 3 chunks from llm2
    expect(chunks).toHaveLength(4);
  });

  it.each([
    {
      name: 'search output',
      extra: { openai: { output: [{ type: 'web_search_call' }] } },
      fallback: false,
    },
    {
      name: 'annotated output',
      extra: {
        openai: {
          output: [
            {
              type: 'message',
              content: [{ annotations: [{ type: 'url_citation', url: 'https://example.com' }] }],
            },
          ],
        },
      },
      fallback: false,
    },
    {
      name: 'explicit retry',
      extra: { openai: { output: [{ type: 'web_search_call' }] } },
      retry: true,
      fallback: true,
    },
    { name: 'phase only', extra: { openai: { phase: 'commentary' } }, fallback: true },
    { name: 'empty output', extra: { openai: { output: [] } }, fallback: true },
    {
      name: 'other metadata',
      extra: { google: { thoughtSignature: 'signature' } },
      fallback: true,
    },
  ])(
    'handles failure after $name according to the fallback policy',
    async ({ extra, retry, fallback }) => {
      const primary = new MockLLM('primary');
      primary.shouldFail = true;
      primary.failAfterChunks = 1;
      primary.chunk = { id: 'primary', delta: { role: 'assistant', extra } };
      const secondary = new MockLLM('secondary');
      const secondaryChat = vi.spyOn(secondary, 'chat');
      const adapter = new FallbackAdapter({ llms: [primary, secondary], retryOnChunkSent: retry });
      const metrics = vi.fn();
      adapter.on('metrics_collected', metrics);
      const errors: Error[] = [];
      adapter.on('error', (event) => errors.push(event.error));

      const result = await adapter.chat({ chatCtx: {} as ChatContext }).collect();

      expect(result.extra).toEqual(extra);
      if (fallback) {
        expect(result.text).toBe('chunkchunkchunk');
        expect(secondaryChat).toHaveBeenCalledOnce();
        expect(errors).toHaveLength(0);
      } else {
        expect(result.text).toBe('');
        expect(secondaryChat).not.toHaveBeenCalled();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(APIError);
        await vi.waitFor(() =>
          expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ ttftMs: -1 })),
        );
      }
    },
  );

  it('should initiate recovery on mid-stream failure with retryOnChunkSent=false', async () => {
    const llm1 = new MockLLM('llm1');
    llm1.shouldFail = true;
    llm1.failAfterChunks = 1;
    const llm2 = new MockLLM('llm2');
    const adapter = new FallbackAdapter({
      llms: [llm1, llm2],
      retryOnChunkSent: false,
    });

    const stream = adapter.chat({
      chatCtx: {} as ChatContext,
    });

    const errorPromise = new Promise<Error>((resolve) => {
      adapter.on('error', (e) => resolve(e.error));
    });

    for await (const _ of stream) {
      // consume
    }

    const error = await errorPromise;
    expect(error).toBeInstanceOf(APIError);
    expect(adapter._status[0]!.available).toBe(false);
    // tryRecovery must have been called despite the throw -- recoveringTask is in flight
    expect(adapter._status[0]!.recoveringTask).not.toBeNull();
  });

  it('should emit availability changed events', async () => {
    const llm1 = new MockLLM('llm1');
    llm1.shouldFail = true;
    const llm2 = new MockLLM('llm2');
    const adapter = new FallbackAdapter({ llms: [llm1, llm2] });

    const eventSpy = vi.fn();
    (adapter as any).on('llm_availability_changed', eventSpy);

    const stream = adapter.chat({
      chatCtx: {} as ChatContext,
    });

    for await (const _ of stream) {
      // consume
    }

    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        llm: llm1,
        available: false,
      }),
    );
  });

  it('names the instance that served in the usage metrics, not the one preferred next', async () => {
    class NamedMockLLM extends MockLLM {
      constructor(
        label: string,
        private readonly _model: string,
        private readonly _provider: string,
      ) {
        super(label);
      }
      override get model(): string {
        return this._model;
      }
      override get provider(): string {
        return this._provider;
      }
    }
    const primary = new NamedMockLLM('primary', 'primary-model', 'primary');
    primary.shouldFail = true;
    const secondary = new NamedMockLLM('secondary', 'secondary-model', 'secondary');
    const adapter = new FallbackAdapter({ llms: [primary, secondary], attemptTimeout: 1 });
    const metrics: Array<{
      label: string;
      metadata?: { modelName?: string; modelProvider?: string };
    }> = [];
    adapter.on('metrics_collected', (m) => metrics.push(m));

    const stream = adapter.chat({ chatCtx: { items: [] } as unknown as ChatContext });
    for await (const _chunk of stream) {
      // drain
    }
    // the primary is preferred again as soon as its recovery probe succeeds; the metrics of
    // the request the secondary served must still say so
    adapter._status[0]!.available = true;
    await delay(20);

    // the instances' own metrics are forwarded as they are; the adapter's own stream reports
    // the instance that served its request
    const adapterMetrics = metrics.filter((m) => m.label === adapter.label());
    expect(adapterMetrics).toHaveLength(1);
    expect(adapterMetrics[0]!.metadata?.modelName).toBe('secondary-model');
    expect(adapterMetrics[0]!.metadata?.modelProvider).toBe('secondary');
  });

  it('reports the model and provider of the instance that serves next', () => {
    class IdentifiedLLM extends MockLLM {
      constructor(
        label: string,
        private readonly _model: string,
        private readonly _provider: string,
      ) {
        super(label);
      }
      override get model(): string {
        return this._model;
      }
      override get provider(): string {
        return this._provider;
      }
    }
    const primary = new IdentifiedLLM('primary', 'primary-model', 'primary');
    const fallback = new IdentifiedLLM('fallback', 'fallback-model', 'fallback');
    const adapter = new FallbackAdapter({ llms: [primary, fallback] });
    // model and provider follow the instance that serves next, so spans and metrics name the
    // model that will answer rather than the adapter; the label stays the adapter's own
    expect(adapter.model).toBe('primary-model');
    expect(adapter.provider).toBe('primary');
    expect(adapter.label()).toContain('FallbackAdapter');
    adapter._status[0]!.available = false;
    expect(adapter.model).toBe('fallback-model');
    expect(adapter.provider).toBe('fallback');
    // once the primary recovers (its recovery task flips it back to available) the next request
    // goes to it first, so that is what model and provider report
    adapter._status[0]!.available = true;
    expect(adapter.model).toBe('primary-model');
  });
});
