// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { delay } from '../utils.js';
import { type ChatContext, FunctionCall } from './chat_context.js';
import { type ChatChunk, LLM, LLMStream } from './llm.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

class MockLLMStream extends LLMStream {
  constructor(
    llm: LLM,
    opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolContext;
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
        connOptions: opts.connOptions ?? ({ maxRetry: 0 } as APIConnectOptions),
      },
      this.chunks,
    );
  }
}

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

    const response = await llm.chat({ chatCtx: {} as ChatContext }).collect();

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

    const response = await llm.chat({ chatCtx: {} as ChatContext }).collect();

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

    const response = await llm.chat({ chatCtx: {} as ChatContext }).collect();

    expect(response.text).toBe('hi there');
    expect(response.usage?.completionTokens).toBe(3);
    expect(response.usage?.totalTokens).toBe(8);
    expect(response.extra).toEqual({ a: 1, b: 2 });
  });

  it('returns empty response for an empty stream', async () => {
    const llm = new MockLLM([]);

    const response = await llm.chat({ chatCtx: {} as ChatContext }).collect();

    expect(response.text).toBe('');
    expect(response.toolCalls).toHaveLength(0);
    expect(response.usage).toBeUndefined();
    expect(response.extra).toEqual({});
  });
});
