// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APIStatusError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import { traceTypes } from '../telemetry/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { ChatContext } from './chat_context.js';
import { type ChatChunk, LLM, type LLMError, LLMStream } from './llm.js';
import { ENV_LLM_REPLAY_URL } from './replay.js';
import { type ToolCtxInput, tool } from './tool_context.js';

class ProviderStream extends LLMStream {
  protected async run(): Promise<void> {
    this.queue.put({ id: 'provider', delta: { role: 'assistant', content: 'from the provider' } });
  }
}

class ProviderLLM extends LLM {
  label(): string {
    return 'provider-llm';
  }

  chat(opts: {
    chatCtx: ChatContext;
    toolCtx?: ToolCtxInput;
    connOptions?: APIConnectOptions;
  }): LLMStream {
    return new ProviderStream(this, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}

const lookupCaller = tool({
  name: 'lookup_caller',
  description: "Look up a caller's record by phone number.",
  execute: async () => '{}',
});

function chatCtx(): ChatContext {
  const ctx = new ChatContext();
  ctx.addMessage({ role: 'system', content: 'You are Sam.' });
  ctx.addMessage({ role: 'user', content: '+1 415 555 0142' });
  return ctx;
}

describe('LLM replay', () => {
  let server: Server;
  let state: { requests: unknown[]; status: number; body: unknown };

  beforeAll(() => {
    initializeLogger({ pretty: false, level: 'silent' });
  });

  beforeEach(async () => {
    state = { requests: [], status: 200, body: {} };
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        state.requests.push(JSON.parse(data));
        res.writeHead(state.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    process.env[ENV_LLM_REPLAY_URL] = `http://127.0.0.1:${port}/llm`;
  });

  afterEach(async () => {
    delete process.env[ENV_LLM_REPLAY_URL];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the recorded output instead of the provider', async () => {
    state.body = {
      response_id: 'chatcmpl-1',
      output_messages: [
        {
          role: 'assistant',
          finish_reason: 'tool_call',
          parts: [
            { type: 'text', content: 'Let me look that up.' },
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'lookup_caller',
              arguments: { phone: '+1 415 555 0142' },
            },
          ],
        },
      ],
    };
    const llm = new ProviderLLM();
    const chunks: ChatChunk[] = [];
    for await (const chunk of llm.chat({ chatCtx: chatCtx(), toolCtx: [lookupCaller] })) {
      chunks.push(chunk);
    }

    expect(state.requests).toEqual([
      {
        model: llm.model,
        provider: traceTypes.genAIProviderName(llm.provider) ?? null,
        system_instructions: [{ type: 'text', content: 'You are Sam.' }],
        input_messages: [{ role: 'user', parts: [{ type: 'text', content: '+1 415 555 0142' }] }],
        tool_definitions: [
          {
            type: 'function',
            name: 'lookup_caller',
            description: "Look up a caller's record by phone number.",
          },
        ],
      },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe('chatcmpl-1');
    expect(chunks[0]!.delta?.content).toBe('Let me look that up.');
    expect(chunks[0]!.delta?.toolCalls).toHaveLength(1);
    expect(chunks[0]!.delta?.toolCalls?.[0]).toMatchObject({
      callId: 'call_1',
      name: 'lookup_caller',
      args: JSON.stringify({ phone: '+1 415 555 0142' }),
    });
  });

  it('fails the stream without retrying when the request diverges', async () => {
    state.status = 409;
    state.body = { error: 'LLM request 1 of 3 diverged from the session' };

    const llm = new ProviderLLM();
    const errors: LLMError[] = [];
    llm.on('error', (e) => errors.push(e));
    const chunks = await llm
      .chat({
        chatCtx: chatCtx(),
        connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 3, retryIntervalMs: 0 },
      })
      .collect();

    expect(chunks.text).toBe('');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(false);
    const error = errors[0]!.error as APIStatusError;
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error.message).toContain('diverged from the session');
    expect(error.statusCode).toBe(409);
    expect(error.retryable).toBe(false);
    expect(state.requests).toHaveLength(1);
  });
});
