// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { ChatContext } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import { type InferenceClass, LLM } from './llm.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

type CapturedHeaders = Record<string, string>;

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
