// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError, APIStatusError, APITimeoutError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { delay } from '../utils.js';
import { type ChatContext, FunctionCall } from './chat_context.js';
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
  ) {
    super(llm, opts);
    this.myLLM = llm;
  }

  protected async run(): Promise<void> {
    if (this.shouldFail && this.failAfterChunks === 0) {
      throw new APIError('Mock LLM failed immediately');
    }

    const chunk: ChatChunk = {
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
    );
  }
}

class RetryLLM extends LLM {
  requests = 0;
  attempts = 0;

  constructor(
    readonly chunk: ChatChunk,
    readonly error: Error,
  ) {
    super();
  }

  label(): string {
    return 'retry';
  }

  chat(opts: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
  }): LLMStream {
    this.requests++;
    return new RetryLLMStream(this, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}

class RetryLLMStream extends LLMStream {
  constructor(
    private readonly retryLLM: RetryLLM,
    opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolContextLike;
      connOptions: APIConnectOptions;
    },
  ) {
    super(retryLLM, opts);
  }

  protected async run(): Promise<void> {
    this.retryLLM.attempts++;
    this.queue.put(this.retryLLM.chunk);
    if (this.retryLLM.attempts === 1) {
      throw this.retryLLM.error;
    }
  }
}

type ScriptedResponse = string | Error | null;

class ScriptedLLM extends LLM {
  responses: ScriptedResponse[];
  requests = 0;
  finish?: Promise<void>;

  constructor(
    private readonly _model: string,
    responses: ScriptedResponse[],
  ) {
    super();
    this.responses = responses;
  }

  override get model(): string {
    return this._model;
  }

  override get provider(): string {
    return `${this._model}-provider`;
  }

  label(): string {
    return this._model;
  }

  chat(opts: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
  }): LLMStream {
    this.requests++;
    const response = this.responses.length > 0 ? this.responses.shift()! : this.model;
    return new ScriptedLLMStream(this, response, this.finish, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions!,
    });
  }
}

class ScriptedLLMStream extends LLMStream {
  constructor(
    llm: LLM,
    private readonly response: ScriptedResponse,
    private readonly finish: Promise<void> | undefined,
    opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolContextLike;
      connOptions: APIConnectOptions;
    },
  ) {
    super(llm, opts);
  }

  protected async run(): Promise<void> {
    if (this.response instanceof Error) {
      throw this.response;
    }
    if (this.response !== null) {
      this.queue.put({ id: this.response, delta: { content: this.response } });
    }
    await this.finish;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const chatCtx = { items: [] } as unknown as ChatContext;

async function waitForRecovery(adapter: FallbackAdapter): Promise<void> {
  await Promise.all(
    adapter._status.flatMap((status) => (status.recoveringTask ? [status.recoveringTask] : [])),
  );
}

async function collectWithError(adapter: FallbackAdapter): Promise<{
  text: string;
  error: Error | undefined;
}> {
  let error: Error | undefined;
  const onError = (event: { error: Error }) => {
    error = event.error;
  };
  adapter.on('error', onError);
  const response = await adapter.chat({ chatCtx }).collect();
  adapter.off('error', onError);
  return { text: response.text, error };
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

  it.each([
    ['text', { id: 'text', delta: { role: 'assistant', content: 'The answer.' } }],
    [
      'tool',
      {
        id: 'tool',
        delta: {
          role: 'assistant',
          toolCalls: [new FunctionCall({ callId: 'call-1', name: 'transfer_call', args: '{}' })],
        },
      },
    ],
  ] as const)('does not retry after %s output', async (_chunkKind, chunk) => {
    for (const withFallback of [false, true]) {
      for (const errorKind of ['timeout', 'status', 'nonretryable', 'unexpected'] as const) {
        for (const childRetries of [0, 1]) {
          for (const sticky of [false, true]) {
            let error: Error;
            if (errorKind === 'status') {
              error = new APIStatusError({
                message: 'After output',
                options: { statusCode: 503, requestId: 'request-1' },
              });
            } else if (errorKind === 'unexpected') {
              error = new Error('After output');
            } else {
              error = new APITimeoutError({
                message: 'After output',
                options: { retryable: errorKind !== 'nonretryable' },
              });
            }
            const primary = new RetryLLM(chunk, error);
            const fallback = new RetryLLM(chunk, new Error('unused'));
            const adapter = new FallbackAdapter({
              llms: withFallback ? [primary, fallback] : [primary],
              maxRetryPerLLM: childRetries,
              sticky,
            });
            const errors: Array<{ error: Error; recoverable: boolean }> = [];
            adapter.on('error', (event) => errors.push(event));
            const chunks: ChatChunk[] = [];

            const stream = adapter.chat({
              chatCtx,
              connOptions: {
                ...DEFAULT_API_CONNECT_OPTIONS,
                maxRetry: 3,
                retryIntervalMs: 0,
              },
            });
            for await (const result of stream) {
              chunks.push(result);
            }

            expect(chunks).toEqual([chunk]);
            expect(primary.requests).toBe(1);
            expect(primary.attempts).toBe(1);
            expect(fallback.requests).toBe(0);
            expect(errors).toHaveLength(1);
            expect(errors[0]!.error).toBe(error);
            expect(errors[0]!.recoverable).toBe(false);
            if (error instanceof APIError) {
              expect(error.retryable).toBe(false);
            }
            await waitForRecovery(adapter);
          }
        }
      }
    }
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

  it('should not initiate recovery on mid-stream failure with retryOnChunkSent=false', async () => {
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
    expect(adapter._status[0]!.recoveringTask).toBeNull();
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

  it.each([
    ['default', undefined],
    ['priority', false],
    ['sticky', true],
  ] as const)('routes to a recovered primary in %s mode', async (_name, sticky) => {
    const primary = new ScriptedLLM('primary', [new APIConnectionError({}), 'recovery']);
    const fallback = new ScriptedLLM('fallback', []);
    const adapter = new FallbackAdapter({
      llms: [primary, fallback],
      ...(sticky === undefined ? {} : { sticky }),
    });

    const first = await adapter.chat({ chatCtx }).collect();
    expect(first.text).toBe('fallback');
    await waitForRecovery(adapter);
    expect(adapter._status[0]!.available).toBe(true);
    expect(primary.requests).toBe(2);

    const expected = sticky ? fallback : primary;
    expect(adapter.model).toBe(expected.model);
    expect(adapter.provider).toBe(expected.provider);
    for (let i = 0; i < 2; i++) {
      const response = await adapter.chat({ chatCtx }).collect();
      expect(response.text).toBe(expected.model);
    }
    expect(primary.requests).toBe(sticky ? 2 : 4);
    expect(fallback.requests).toBe(sticky ? 3 : 1);
  });

  it.each([false, true])(
    'uses remaining priority order after the sticky model fails (primaryRecovers=%s)',
    async (primaryRecovers) => {
      const primary = new ScriptedLLM('primary', [
        new APIConnectionError({}),
        ...(primaryRecovers
          ? []
          : [new APIConnectionError({}), new APIConnectionError({}), new APIConnectionError({})]),
      ]);
      const fallback = new ScriptedLLM('fallback', ['fallback', new APIConnectionError({})]);
      const last = new ScriptedLLM('last', []);
      const adapter = new FallbackAdapter({ llms: [primary, fallback, last], sticky: true });

      const first = await adapter.chat({ chatCtx }).collect();
      expect(first.text).toBe('fallback');
      await waitForRecovery(adapter);

      const response = await adapter.chat({ chatCtx }).collect();
      const expected = primaryRecovers ? primary : last;
      expect(response.text).toBe(expected.model);
      await waitForRecovery(adapter);
      expect(fallback.requests).toBe(3);
      expect(last.requests).toBe(primaryRecovers ? 0 : 1);
      expect(adapter.model).toBe(expected.model);
      expect(adapter.provider).toBe(expected.provider);

      const next = await adapter.chat({ chatCtx }).collect();
      expect(next.text).toBe(expected.model);
    },
  );

  it('retries from primary when all sticky models are unavailable', async () => {
    const primary = new ScriptedLLM(
      'primary',
      Array.from({ length: 5 }, () => new APIConnectionError({})),
    );
    const fallback = new ScriptedLLM('fallback', [
      'fallback',
      ...Array.from({ length: 5 }, () => new APIConnectionError({})),
    ]);
    const adapter = new FallbackAdapter({ llms: [primary, fallback], sticky: true });

    const first = await adapter.chat({ chatCtx }).collect();
    expect(first.text).toBe('fallback');
    await waitForRecovery(adapter);

    const failed = await collectWithError(adapter);
    expect(failed.error).toBeInstanceOf(APIConnectionError);
    await waitForRecovery(adapter);
    expect(adapter._status.every((status) => !status.available)).toBe(true);

    primary.responses.length = 0;
    fallback.responses.length = 0;
    const fallbackRequests = fallback.requests;
    expect(adapter.model).toBe('primary');
    const response = await adapter.chat({ chatCtx }).collect();
    expect(response.text).toBe('primary');
    expect(fallback.requests).toBe(fallbackRequests);
  });

  it('keeps the sticky model that succeeds after all models failed', async () => {
    const primary = new ScriptedLLM('primary', [
      new APIConnectionError({}),
      new APIConnectionError({}),
      new APIConnectionError({}),
      'recovery',
    ]);
    const fallback = new ScriptedLLM('fallback', [
      new APIConnectionError({}),
      new APIConnectionError({}),
    ]);
    const adapter = new FallbackAdapter({ llms: [primary, fallback], sticky: true });

    const failed = await collectWithError(adapter);
    expect(failed.error).toBeInstanceOf(APIConnectionError);
    await waitForRecovery(adapter);
    expect(adapter._status.every((status) => !status.available)).toBe(true);

    const response = await adapter.chat({ chatCtx }).collect();
    expect(response.text).toBe('fallback');
    await waitForRecovery(adapter);
    expect(adapter._status[0]!.available).toBe(true);

    const next = await adapter.chat({ chatCtx }).collect();
    expect(next.text).toBe('fallback');
    expect(primary.requests).toBe(4);
  });

  it.each([false, true])(
    'lets sticky success override a concurrent failed attempt (primaryRecoversFirst=%s)',
    async (primaryRecoversFirst) => {
      const primary = new ScriptedLLM('primary', [
        new APIConnectionError({}),
        'recovery',
        new APIConnectionError({}),
        'recovery',
      ]);
      const fallback = new ScriptedLLM('fallback', [
        'fallback',
        'fallback',
        new APIConnectionError({}),
        new APIConnectionError({}),
      ]);
      const adapter = new FallbackAdapter({ llms: [primary, fallback], sticky: true });
      const fallbackFinish = deferred();
      const primaryRecoveryFinish = deferred();

      const first = await adapter.chat({ chatCtx }).collect();
      expect(first.text).toBe('fallback');
      await waitForRecovery(adapter);

      fallback.finish = fallbackFinish.promise;
      const olderStream = adapter.chat({ chatCtx });
      const chunk = await olderStream.next();
      expect(chunk.value?.delta?.content).toBe('fallback');
      fallback.finish = undefined;
      primary.finish = primaryRecoveryFinish.promise;

      const failed = await collectWithError(adapter);
      expect(failed.error).toBeInstanceOf(APIConnectionError);

      if (primaryRecoversFirst) {
        primaryRecoveryFinish.resolve();
        await waitForRecovery(adapter);
      }

      fallbackFinish.resolve();
      await olderStream.collect();
      primaryRecoveryFinish.resolve();
      await waitForRecovery(adapter);
      expect(adapter.model).toBe('fallback');
      expect(adapter.provider).toBe('fallback-provider');

      const response = await adapter.chat({ chatCtx }).collect();
      expect(response.text).toBe('fallback');
      expect(primary.requests).toBe(4);
      expect(fallback.requests).toBe(5);
    },
  );

  it.each([false, true])(
    'preserves a newer successful failover when an older sticky request succeeds (olderFinishesFirst=%s)',
    async (olderFinishesFirst) => {
      const primary = new ScriptedLLM('primary', [
        new APIConnectionError({}),
        'recovery',
        'primary',
      ]);
      const fallback = new ScriptedLLM('fallback', [
        'fallback',
        'fallback',
        new APIConnectionError({}),
        'recovery',
      ]);
      const adapter = new FallbackAdapter({ llms: [primary, fallback], sticky: true });
      const fallbackFinish = deferred();
      const primaryFinish = deferred();

      const first = await adapter.chat({ chatCtx }).collect();
      expect(first.text).toBe('fallback');
      await waitForRecovery(adapter);

      fallback.finish = fallbackFinish.promise;
      const olderStream = adapter.chat({ chatCtx });
      const olderChunk = await olderStream.next();
      expect(olderChunk.value?.delta?.content).toBe('fallback');
      fallback.finish = undefined;
      primary.finish = primaryFinish.promise;

      const newerStream = adapter.chat({ chatCtx });
      const newerChunk = await newerStream.next();
      expect(newerChunk.value?.delta?.content).toBe('primary');
      await waitForRecovery(adapter);

      if (olderFinishesFirst) {
        fallbackFinish.resolve();
        await olderStream.collect();
      }

      primaryFinish.resolve();
      await newerStream.collect();
      if (!olderFinishesFirst) {
        fallbackFinish.resolve();
        await olderStream.collect();
      }

      expect(adapter.model).toBe('primary');
      primary.finish = undefined;
      const response = await adapter.chat({ chatCtx }).collect();
      expect(response.text).toBe('primary');
      expect(primary.requests).toBe(4);
      expect(fallback.requests).toBe(4);
    },
  );

  it.each([false, true])(
    'lets older sticky success replace a failed newer selection (newerRecovers=%s)',
    async (newerRecovers) => {
      const primary = new ScriptedLLM('primary', [
        new APIConnectionError({}),
        new APIConnectionError({}),
        new APIConnectionError({}),
        'recovery',
      ]);
      const middle = new ScriptedLLM('middle', [
        'middle',
        'middle',
        new APIConnectionError({}),
        new APIConnectionError({}),
        new APIConnectionError({}),
      ]);
      const last = new ScriptedLLM('last', [
        'last',
        new APIConnectionError({}),
        newerRecovers ? 'recovery' : new APIConnectionError({}),
      ]);
      const adapter = new FallbackAdapter({ llms: [primary, middle, last], sticky: true });
      const finish = deferred();

      const first = await adapter.chat({ chatCtx }).collect();
      expect(first.text).toBe('middle');
      await waitForRecovery(adapter);

      middle.finish = finish.promise;
      const olderStream = adapter.chat({ chatCtx });
      const olderChunk = await olderStream.next();
      expect(olderChunk.value?.delta?.content).toBe('middle');
      middle.finish = undefined;

      const response = await adapter.chat({ chatCtx }).collect();
      expect(response.text).toBe('last');
      await waitForRecovery(adapter);

      const failed = await collectWithError(adapter);
      expect(failed.error).toBeInstanceOf(APIConnectionError);
      await waitForRecovery(adapter);
      expect(adapter._status.map((status) => status.available)).toEqual([
        true,
        false,
        newerRecovers,
      ]);

      finish.resolve();
      await olderStream.collect();
      expect(adapter.model).toBe('middle');
      const next = await adapter.chat({ chatCtx }).collect();
      expect(next.text).toBe('middle');
    },
  );

  it.each([false, true])(
    'keeps the sticky model after its stream closes (emptyResponse=%s)',
    async (emptyResponse) => {
      const primary = new ScriptedLLM('primary', [new APIConnectionError({})]);
      const fallback = new ScriptedLLM('fallback', emptyResponse ? [null] : []);
      const finish = deferred();
      if (!emptyResponse) {
        fallback.finish = finish.promise;
      }
      const adapter = new FallbackAdapter({ llms: [primary, fallback], sticky: true });

      const stream = adapter.chat({ chatCtx });
      if (emptyResponse) {
        expect(await stream.collect()).toEqual(
          expect.objectContaining({ text: '', toolCalls: [] }),
        );
      } else {
        const chunk = await stream.next();
        expect(chunk.value?.delta?.content).toBe('fallback');
        await waitForRecovery(adapter);
        stream.close();
        finish.resolve();
      }
      fallback.finish = undefined;

      const response = await adapter.chat({ chatCtx }).collect();
      expect(response.text).toBe('fallback');
      expect(primary.requests).toBe(2);
      expect(adapter.model).toBe('fallback');
      expect(adapter.provider).toBe('fallback-provider');
    },
  );
});
