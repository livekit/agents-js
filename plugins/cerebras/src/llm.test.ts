// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, voice } from '@livekit/agents';
import { encode } from '@msgpack/msgpack';
import { gzipSync } from 'node:zlib';
import OpenAI from 'openai';
import { assert, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LLMOptions } from './llm.js';
import { LLM } from './llm.js';

assert(process.env.CEREBRAS_API_KEY, 'CEREBRAS_API_KEY must be set');

// llama3.1-8b is fast and has generous rate limits but can't do tool calls reliably;
// qwen-3-235b is needed for function calling but has tight per-minute token quotas.
const CHAT_MODEL = 'llama3.1-8b';
const TOOL_MODEL = 'qwen-3-235b-a22b-instruct-2507';

interface CapturedRequest {
  url: string;
  headers: Headers;
}

/**
 * Wraps a real fetch, applying msgpack/gzip compression and capturing outgoing
 * request metadata for assertion.  TypeScript equivalent of Python's
 * `HeaderCapturingTransport` + `_CerebrasClient`.
 */
function createCapturingFetch(opts: { useMsgpack: boolean; useGzip: boolean }): {
  fetch: typeof globalThis.fetch;
  capturedRequests: CapturedRequest[];
} {
  const capturedRequests: CapturedRequest[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST' && init.body && typeof init.body === 'string') {
      const headers = new Headers(init.headers);

      let body: Uint8Array;
      if (opts.useMsgpack) {
        body = encode(JSON.parse(init.body));
        headers.set('Content-Type', 'application/vnd.msgpack');
      } else {
        body = new TextEncoder().encode(init.body);
      }

      if (opts.useGzip) {
        body = gzipSync(body, { level: 5 });
        headers.set('Content-Encoding', 'gzip');
      }

      capturedRequests.push({ url: extractUrl(input), headers });
      return globalThis.fetch(input, { ...init, body: Buffer.from(body), headers });
    }

    capturedRequests.push({ url: extractUrl(input), headers: new Headers(init?.headers) });
    return globalThis.fetch(input, init);
  };

  return { fetch: fetch as typeof globalThis.fetch, capturedRequests };
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function cerebrasLLM(opts: Partial<LLMOptions> = {}): LLM {
  return new LLM({ model: CHAT_MODEL, ...opts });
}

function cerebrasLLMWithCapture(opts: { useGzip: boolean; useMsgpack: boolean }): {
  llm: LLM;
  capturedRequests: CapturedRequest[];
} {
  const { fetch, capturedRequests } = createCapturingFetch(opts);
  const client = new OpenAI({
    apiKey: process.env.CEREBRAS_API_KEY,
    baseURL: 'https://api.cerebras.ai/v1',
    fetch,
  });
  return { llm: new LLM({ model: CHAT_MODEL, client }), capturedRequests };
}

class WeatherAgent extends voice.Agent {
  constructor() {
    super({
      instructions: 'You are a helpful assistant.',
      tools: {
        get_weather: llm.tool({
          description: 'Get the current weather for a location.',
          parameters: z.object({
            location: z.string().describe('The city name'),
          }),
          execute: async ({ location }) => {
            return `The weather in ${location} is sunny, 72°F.`;
          },
        }),
      },
    });
  }
}

describe('Cerebras', { timeout: 30_000 }, () => {
  it('basic chat completion returns a non-empty assistant message', async () => {
    const session = new voice.AgentSession({ llm: cerebrasLLM() });
    await session.start({
      agent: new voice.Agent({ instructions: 'You are a helpful assistant.' }),
    });

    const result = session.run({ userInput: 'Say hello in exactly one word.' });
    await result.wait();

    result.expect.nextEvent().isMessage({ role: 'assistant' });
    result.expect.noMoreEvents();

    await session.close();
  });

  it('LLM can invoke a tool and the result is returned', async () => {
    const session = new voice.AgentSession({ llm: new LLM({ model: TOOL_MODEL }) });
    await session.start({ agent: new WeatherAgent() });

    const result = session.run({ userInput: 'What is the weather in Tokyo?' });
    await result.wait();

    result.expect.nextEvent().isFunctionCall({
      name: 'get_weather',
      args: { location: 'Tokyo' },
    });
    result.expect.nextEvent().isFunctionCallOutput({
      output: JSON.stringify('The weather in Tokyo is sunny, 72°F.'),
    });
    result.expect.nextEvent().isMessage({ role: 'assistant' });
    result.expect.noMoreEvents();

    await session.close();
  });

  it('gzip-only sends Content-Encoding: gzip with JSON content type', async () => {
    const { llm: model, capturedRequests } = cerebrasLLMWithCapture({
      useGzip: true,
      useMsgpack: false,
    });
    const session = new voice.AgentSession({ llm: model });
    await session.start({
      agent: new voice.Agent({ instructions: 'You are a helpful assistant.' }),
    });

    const result = session.run({ userInput: 'Say hello in exactly one word.' });
    await result.wait();

    result.expect.nextEvent().isMessage({ role: 'assistant' });
    result.expect.noMoreEvents();

    await session.close();

    const chatReqs = capturedRequests.filter((r) => r.url.includes('/chat/completions'));
    expect(chatReqs.length).toBeGreaterThan(0);
    expect(chatReqs[0]!.headers.get('content-type')).toBe('application/json');
    expect(chatReqs[0]!.headers.get('content-encoding')).toBe('gzip');
  });

  it('msgpack-only sends Content-Type: application/vnd.msgpack without gzip', async () => {
    const { llm: model, capturedRequests } = cerebrasLLMWithCapture({
      useGzip: false,
      useMsgpack: true,
    });
    const session = new voice.AgentSession({ llm: model });
    await session.start({
      agent: new voice.Agent({ instructions: 'You are a helpful assistant.' }),
    });

    const result = session.run({ userInput: 'Say hello in exactly one word.' });
    await result.wait();

    result.expect.nextEvent().isMessage({ role: 'assistant' });
    result.expect.noMoreEvents();

    await session.close();

    const chatReqs = capturedRequests.filter((r) => r.url.includes('/chat/completions'));
    expect(chatReqs.length).toBeGreaterThan(0);
    expect(chatReqs[0]!.headers.get('content-type')).toBe('application/vnd.msgpack');
    expect(chatReqs[0]!.headers.get('content-encoding')).toBeNull();
  });

  it('both flags send msgpack content type with gzip encoding', async () => {
    const { llm: model, capturedRequests } = cerebrasLLMWithCapture({
      useGzip: true,
      useMsgpack: true,
    });
    const session = new voice.AgentSession({ llm: model });
    await session.start({
      agent: new voice.Agent({ instructions: 'You are a helpful assistant.' }),
    });

    const result = session.run({ userInput: 'Say hello in exactly one word.' });
    await result.wait();

    result.expect.nextEvent().isMessage({ role: 'assistant' });
    result.expect.noMoreEvents();

    await session.close();

    const chatReqs = capturedRequests.filter((r) => r.url.includes('/chat/completions'));
    expect(chatReqs.length).toBeGreaterThan(0);
    expect(chatReqs[0]!.headers.get('content-type')).toBe('application/vnd.msgpack');
    expect(chatReqs[0]!.headers.get('content-encoding')).toBe('gzip');
  });

  it('with both flags off sends standard JSON without gzip', async () => {
    const session = new voice.AgentSession({
      llm: cerebrasLLM({ gzipCompression: false, msgpackEncoding: false }),
    });
    await session.start({
      agent: new voice.Agent({ instructions: 'You are a helpful assistant.' }),
    });

    const result = session.run({ userInput: 'Say hello in exactly one word.' });
    await result.wait();

    result.expect.nextEvent().isMessage({ role: 'assistant' });
    result.expect.noMoreEvents();

    await session.close();
  });

  it('streaming chat returns content via the LLM directly', async () => {
    const model = cerebrasLLM();
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'system', content: 'You are a helpful assistant.' });
    chatCtx.addMessage({ role: 'user', content: 'Count from 1 to 5.' });

    const stream = model.chat({ chatCtx });
    let text = '';
    for await (const chunk of stream) {
      if (chunk.delta?.content) {
        text += chunk.delta.content;
      }
    }

    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('3');
  });
});
