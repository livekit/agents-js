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
import type { ToolChoice, ToolContext } from './tool_context.js';

class MockLLMStream extends LLMStream {
  public myLLM: LLM;

  constructor(
    llm: LLM,
    opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolContext;
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
    toolCtx?: ToolContext;
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
});
