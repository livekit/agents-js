// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import * as agents from '../index.js';
import { ChatContext } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import { type InferenceClass, LLM } from './llm.js';
import { describeLiveKitInference } from './test_utils.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

type CapturedHeaders = Record<string, string>;
type CompletionChunk = Record<string, unknown>;

/**
 * Build an LLM, stub its OpenAI client's chat.completions.create, start a chat
 * stream with the given per-call value, drain the stream, and return the headers
 * that were passed to the create call.
 */
async function captureHeaders(opts: {
  ctor?: InferenceClass;
  perCall?: InferenceClass;
}): Promise<CapturedHeaders> {
  const llm = new LLM({
    model: 'openai/gpt-4o-mini',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
    inferenceClass: opts.ctor,
  });

  let capturedHeaders: CapturedHeaders = {};

  const stub = async (_body: unknown, options?: unknown) => {
    capturedHeaders = (options as { headers?: CapturedHeaders } | undefined)?.headers ?? {};
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
  };

  const internal = llm as unknown as {
    client: { chat: { completions: { create: typeof stub } } };
  };
  internal.client.chat.completions.create = stub;

  const stream = llm.chat({
    chatCtx: new ChatContext(),
    inferenceClass: opts.perCall,
  });

  // Drain the stream so run() completes and headers get captured.
  for await (const _chunk of stream) {
    // no-op — stub yields zero chunks
    void _chunk;
  }

  return capturedHeaders;
}

async function collectChatChunks(
  completionChunks: CompletionChunk[],
  model = 'openai/gpt-4o-mini',
) {
  const llm = new LLM({
    model,
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
  });

  const stub = async () => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of completionChunks) {
        yield chunk;
      }
    },
  });

  const internal = llm as unknown as {
    client: { chat: { completions: { create: typeof stub } } };
  };
  internal.client.chat.completions.create = stub;

  const stream = llm.chat({ chatCtx: new ChatContext() });
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

describe('inference.LLM X-LiveKit-Inference-Priority header', () => {
  // --- no value anywhere ---

  it('omits the header when neither constructor nor chat() sets inferenceClass', async () => {
    const headers = await captureHeaders({});
    expect(headers['X-LiveKit-Inference-Priority']).toBeUndefined();
  });

  // --- constructor-only ---

  it("uses constructor 'priority' when chat() does not override", async () => {
    const headers = await captureHeaders({ ctor: 'priority' });
    expect(headers['X-LiveKit-Inference-Priority']).toBe('priority');
  });

  it("uses constructor 'standard' when chat() does not override", async () => {
    const headers = await captureHeaders({ ctor: 'standard' });
    expect(headers['X-LiveKit-Inference-Priority']).toBe('standard');
  });

  // --- per-call-only ---

  it("uses per-call 'priority' when no constructor default is set", async () => {
    const headers = await captureHeaders({ perCall: 'priority' });
    expect(headers['X-LiveKit-Inference-Priority']).toBe('priority');
  });

  it("uses per-call 'standard' when no constructor default is set", async () => {
    const headers = await captureHeaders({ perCall: 'standard' });
    expect(headers['X-LiveKit-Inference-Priority']).toBe('standard');
  });

  // --- per-call overrides constructor ---

  it("per-call 'standard' overrides constructor 'priority'", async () => {
    const headers = await captureHeaders({ ctor: 'priority', perCall: 'standard' });
    expect(headers['X-LiveKit-Inference-Priority']).toBe('standard');
  });

  it("per-call 'priority' overrides constructor 'standard'", async () => {
    const headers = await captureHeaders({ ctor: 'standard', perCall: 'priority' });
    expect(headers['X-LiveKit-Inference-Priority']).toBe('priority');
  });
});

describe('inference.LLM streamed tool calls', () => {
  it('does not expose content alongside tool calls', async () => {
    const chunks = await collectChatChunks(
      [
        {
          id: 'chatcmpl_test',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              delta: {
                role: 'assistant',
                content: 'Let me check that.\n\n<|channel>thought\n<channel|>',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    type: 'function',
                    function: {
                      name: 'saveAnswer',
                      arguments: '{"answer":"yes"}',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      'google/gemma-4-31b-it',
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.delta?.content).toBeUndefined();
    expect(chunks[0]?.delta?.toolCalls).toHaveLength(1);
    expect(chunks[0]?.delta?.toolCalls?.[0]?.callId).toBe('call_123');
    expect(chunks[0]?.delta?.toolCalls?.[0]?.name).toBe('saveAnswer');
    expect(chunks[0]?.delta?.toolCalls?.[0]?.args).toBe('{"answer":"yes"}');
  });
});

describe('inference.LLM reasoning markers', () => {
  it('does not flush a split marker when finish_reason is omitted', async () => {
    const chunks = await collectChatChunks(
      [
        {
          id: 'chatcmpl_test',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: 'before<|chan',
              },
            },
          ],
        },
        {
          id: 'chatcmpl_test',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              delta: {
                content: 'nel>thought\nprivate reasoning<channel|>answer',
              },
            },
          ],
        },
      ],
      'google/gemma-4-31b-it',
    );

    expect(chunks.map((chunk) => chunk.delta?.content).join('')).toBe('beforeanswer');
  });
});

describeLiveKitInference('LiveKit Inference LLM integration', agents, async (harness) => {
  const liveConnOptions = { maxRetry: 3, retryIntervalMs: 2000, timeoutMs: 30000 };

  const withLiveConnOptions = (llm: LLM): LLM => {
    const chat = llm.chat.bind(llm);
    llm.chat = ((opts) => chat({ ...opts, connOptions: liveConnOptions })) as LLM['chat'];
    return llm;
  };

  for (const model of [
    'google/gemma-4-31b-it',
    'openai/gpt-4.1-mini',
    'google/gemini-2.5-flash',
    'openai/gpt-oss-120b',
  ] as const) {
    describe(model, async () => {
      await harness.llm(withLiveConnOptions(new LLM({ model })), false);
    });
  }

  describe('openai/gpt-4.1-mini strict tool schema', async () => {
    await harness.llmStrict(
      withLiveConnOptions(new LLM({ model: 'openai/gpt-4.1-mini', strictToolSchema: true })),
    );
  });
});
