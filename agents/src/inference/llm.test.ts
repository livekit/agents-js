// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as agents from '../index.js';
import { ChatContext } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import type { LLMMetrics } from '../metrics/base.js';
import { type InferenceClass, LLM } from './llm.js';
import { describeLiveKitInference } from './test_utils.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

type CapturedHeaders = Record<string, string>;
type CompletionChunk = Record<string, unknown>;

describe('inference.LLM prewarm', () => {
  it('refreshes the access token before listing models and forwards cancellation', async () => {
    const llm = new LLM({
      model: 'openai/gpt-4o-mini',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
    });
    const internal = llm as unknown as {
      client: {
        apiKey: string;
        models: {
          list: (options: { signal?: AbortSignal }) => Promise<void>;
        };
      };
    };
    let apiKeyAtList = '';
    let prewarmSignal: AbortSignal | undefined;
    const modelsList = vi.fn(async (options: { signal?: AbortSignal }) => {
      apiKeyAtList = internal.client.apiKey;
      prewarmSignal = options.signal;
    });
    internal.client.models.list = modelsList;

    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(modelsList).toHaveBeenCalledTimes(1);
    expect(apiKeyAtList).not.toBe('placeholder');
    expect(apiKeyAtList.split('.')).toHaveLength(3);
    expect(prewarmSignal).toBeInstanceOf(AbortSignal);
    expect(prewarmSignal?.aborted).toBe(false);

    await llm.aclose();
    expect(prewarmSignal?.aborted).toBe(true);
  });
});

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

/**
 * Yields the given completion chunks, then throws as a provider going quiet
 * would. Returns how many times the request was attempted.
 */
async function countAttemptsUntilStall(
  completionChunks: CompletionChunk[],
  maxRetry: number,
): Promise<{ attempts: number }> {
  const llm = new LLM({
    model: 'google/gemma-4-31b-it',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
  });

  // The stream emits 'error' on every failed attempt; without a listener the
  // EventEmitter turns it into an unhandled error and fails the run.
  llm.on('error', () => {});

  let attempts = 0;
  const stub = async () => {
    attempts++;
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of completionChunks) {
          yield chunk;
        }
        throw new Error('stalled mid-stream');
      },
    };
  };

  const internal = llm as unknown as {
    client: { chat: { completions: { create: typeof stub } } };
  };
  internal.client.chat.completions.create = stub;

  try {
    const stream = llm.chat({
      chatCtx: new ChatContext(),
      connOptions: { maxRetry, retryIntervalMs: 0, timeoutMs: 5000 },
    });
    for await (const _chunk of stream) {
      void _chunk;
    }
  } catch {
    // the stall surfaces through the 'error' event; the iterator just ends
  }

  return { attempts };
}

// The gateway stamps its deployment and billing tier onto the leading delta,
// which carries no content of its own.
const METADATA_ONLY_CHUNK: CompletionChunk = {
  id: 'chatcmpl_test',
  choices: [
    {
      index: 0,
      finish_reason: null,
      delta: {
        role: 'assistant',
        extra_content: {
          livekit: { inference_deployment: 'd', inference_tier_billed: 'standard' },
        },
      },
    },
  ],
};

const TEXT_CHUNK: CompletionChunk = {
  id: 'chatcmpl_test',
  choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: 'hello' } }],
};

describe('inference.LLM retry eligibility', () => {
  it('retries a stall that follows provider metadata alone', async () => {
    const { attempts } = await countAttemptsUntilStall([METADATA_ONLY_CHUNK], 2);

    expect(attempts).toBe(3);
  });

  it('does not retry once generated text has reached the caller', async () => {
    const { attempts } = await countAttemptsUntilStall([METADATA_ONLY_CHUNK, TEXT_CHUNK], 2);

    expect(attempts).toBe(1);
  });
});

const STALL_MS = 60;

/**
 * First attempt yields metadata, waits, then stalls; the retry succeeds. Returns
 * the ttft the run reported.
 */
async function ttftAcrossARetry(): Promise<number> {
  const llm = new LLM({
    model: 'google/gemma-4-31b-it',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
  });
  llm.on('error', () => {});

  let reported = -1;
  llm.on('metrics_collected', (metrics) => {
    reported = metrics.ttftMs;
  });

  let attempts = 0;
  const stub = async () => {
    attempts++;
    const failing = attempts === 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield METADATA_ONLY_CHUNK;
        if (failing) {
          await new Promise((resolve) => setTimeout(resolve, STALL_MS));
          throw new Error('stalled mid-stream');
        }
        yield TEXT_CHUNK;
      },
    };
  };

  const internal = llm as unknown as {
    client: { chat: { completions: { create: typeof stub } } };
  };
  internal.client.chat.completions.create = stub;

  const stream = llm.chat({
    chatCtx: new ChatContext(),
    connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 5000 },
  });
  for await (const _chunk of stream) {
    void _chunk;
  }
  // metrics are emitted just after the output stream closes
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(attempts).toBe(2);
  return reported;
}

describe('inference.LLM reported latency', () => {
  it('measures ttft to generation, not to a failed attempt metadata chunk', async () => {
    const ttftMs = await ttftAcrossARetry();

    expect(ttftMs).toBeGreaterThanOrEqual(STALL_MS);
  });
});

const USAGE_CHUNK: CompletionChunk = {
  id: 'chatcmpl_test',
  choices: [],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
};

// A model told to end the call without speaking answers with no content at all.
async function runResponseThatGeneratesNothing(): Promise<{
  attempts: number;
  metrics: LLMMetrics[];
}> {
  const llm = new LLM({
    model: 'google/gemma-4-31b-it',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
  });
  llm.on('error', () => {});

  const metrics: LLMMetrics[] = [];
  llm.on('metrics_collected', (m) => metrics.push(m));

  let attempts = 0;
  const stub = async () => {
    attempts++;
    return {
      async *[Symbol.asyncIterator]() {
        yield METADATA_ONLY_CHUNK;
        yield USAGE_CHUNK;
      },
    };
  };

  const internal = llm as unknown as {
    client: { chat: { completions: { create: typeof stub } } };
  };
  internal.client.chat.completions.create = stub;

  const stream = llm.chat({
    chatCtx: new ChatContext(),
    connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 5000 },
  });
  for await (const _chunk of stream) {
    void _chunk;
  }
  // metrics are emitted just after the output stream closes
  await new Promise((resolve) => setTimeout(resolve, 20));

  return { attempts, metrics };
}

describe('inference.LLM response that generates nothing', () => {
  it('completes on the first attempt, reporting no ttft and the tokens it used', async () => {
    const { attempts, metrics } = await runResponseThatGeneratesNothing();

    expect(attempts).toBe(1);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.ttftMs).toBe(-1);
    expect(metrics[0]!.completionTokens).toBe(7);
    expect(metrics[0]!.totalTokens).toBe(18);
  });
});

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
