// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../../agents/src/log.js';
import { LLM } from './llm.js';

// LLMStream base class initializes a logger on construction.
// Without this call all chat() calls throw "logger not initialized".
beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

/** Create a minimal ChatContext mock for testing. */
function makeChatCtx(messages: Array<{ role: string; text: string }>) {
  return {
    items: messages.map((m) => ({
      role: m.role,
      textContent: m.text,
      type: 'message',
    })),
  };
}

/** Build an SSE response body from an array of string chunks. */
function makeSseBody(chunks: string[], format: 'sse' | 'raw' = 'sse'): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        let line: string;
        if (format === 'sse') {
          line = `data: ${JSON.stringify({ content: chunk })}\n\n`;
        } else {
          line = `${JSON.stringify({ content: chunk })}\n`;
        }
        controller.enqueue(encoder.encode(line));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

describe('LLM', () => {
  it('throws when botId is not provided', () => {
    // @ts-expect-error Testing invalid usage
    expect(() => new LLM({ apiUrl: 'http://llm:8080' })).toThrow('botId is required');
  });

  it('creates with valid botId', () => {
    const llmInstance = new LLM({ botId: 'test-bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
    expect(llmInstance.label()).toBe('blaze.LLM');
  });

  it('updateOptions does not throw', () => {
    const llmInstance = new LLM({ botId: 'test-bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
    expect(() =>
      llmInstance.updateOptions({ deepSearch: true, agenticSearch: true }),
    ).not.toThrow();
  });

  it('updateOptions applies apiUrl to subsequent requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: makeSseBody(['ok']),
    });
    vi.stubGlobal('fetch', fetchMock);

    const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://old-url:8080' });
    llmInstance.updateOptions({ apiUrl: 'http://new-url:9090' });

    const ctx = makeChatCtx([{ role: 'user', text: 'hi' }]);
    const stream = llmInstance.chat({ chatCtx: ctx as never });
    llmInstance.on('error', () => {});
    for await (const _ of stream) { /* consume */ }

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('http://new-url:9090');
    expect(url).not.toContain('old-url');

    vi.unstubAllGlobals();
  });

  describe('chat() streaming', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sends correct request to chat endpoint', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: makeSseBody(['Hello', ' world']),
      });

      const llmInstance = new LLM({
        botId: 'my-bot',
        authToken: 'test-token',
        apiUrl: 'http://llm:8080',
      });
      const ctx = makeChatCtx([{ role: 'user', text: 'Hi' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/v1/voicebot-call/my-bot/chat-conversion-stream');
      expect(url).toContain('is_voice_call=true');
      expect(url).toContain('use_tool_based=false');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      });

      const body = JSON.parse(init.body as string) as Array<{ role: string; content: string }>;
      expect(body).toEqual([{ role: 'user', content: 'Hi' }]);
    });

    it('yields content chunks from SSE stream', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: makeSseBody(['Xin ', 'chào', '!']),
      });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([{ role: 'user', text: 'Chào' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      const texts: string[] = [];
      for await (const chunk of stream) {
        if (chunk.delta?.content) texts.push(chunk.delta.content);
      }

      expect(texts).toEqual(['Xin ', 'chào', '!']);
    });

    it('handles alternative SSE data format (text field)', async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"text": "hello"}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      fetchMock.mockResolvedValue({ ok: true, body });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([{ role: 'user', text: 'test' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      const texts: string[] = [];
      for await (const chunk of stream) {
        if (chunk.delta?.content) texts.push(chunk.delta.content);
      }

      expect(texts).toEqual(['hello']);
    });

    it('handles delta.text SSE format', async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"delta": {"text": "world"}}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      fetchMock.mockResolvedValue({ ok: true, body });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([{ role: 'user', text: 'test' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      const texts: string[] = [];
      for await (const chunk of stream) {
        if (chunk.delta?.content) texts.push(chunk.delta.content);
      }

      expect(texts).toEqual(['world']);
    });

    it('emits final usage chunk', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: makeSseBody(['hi']),
      });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([{ role: 'user', text: 'test' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      const allChunks = [];
      for await (const chunk of stream) allChunks.push(chunk);

      const usageChunk = allChunks.find((c) => c.usage !== undefined);
      expect(usageChunk).toBeDefined();
      expect(usageChunk?.usage?.completionTokens).toBeGreaterThan(0);
    });

    it('includes deepSearch and agenticSearch query params when enabled', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: makeSseBody(['ok']),
      });

      const llmInstance = new LLM({
        botId: 'bot',
        authToken: 'tok',
        apiUrl: 'http://llm:8080',
        deepSearch: true,
        agenticSearch: true,
        demographics: { gender: 'female', age: 30 },
      });
      const ctx = makeChatCtx([{ role: 'user', text: 'search' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      for await (const _ of stream) {
        /* consume */
      }

      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const url = firstCall![0] as string;
      expect(url).toContain('deep_search=true');
      expect(url).toContain('agentic_search=true');
      expect(url).toContain('gender=female');
      expect(url).toContain('age=30');
    });

    it('converts system role messages to user context', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: makeSseBody(['ok']),
      });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([
        { role: 'system', text: 'You are a helpful assistant.' },
        { role: 'user', text: 'Hello' },
      ]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      for await (const _ of stream) {
        /* consume */
      }

      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const body = JSON.parse((firstCall![1] as RequestInit).body as string) as Array<{
        role: string;
        content: string;
      }>;
      // System messages are SKIPPED — Blaze chatapp loads the prompt from DB.
      // Only the user message should appear.
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({ role: 'user', content: 'Hello' });
    });
    it('merges system/developer messages into one', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: makeSseBody(['ok']),
      });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([
        { role: 'system', text: 'You are a helpful assistant.' },
        { role: 'user', text: 'Hello' },
        { role: 'developer', text: 'Be concise.' },
      ]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      for await (const _ of stream) {
        /* consume */
      }

      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const body = JSON.parse((firstCall![1] as RequestInit).body as string) as Array<{
        role: string;
        content: string;
      }>;
      // system & developer messages are both SKIPPED — only the user message is sent.
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({ role: 'user', content: 'Hello' });
    });
    it('handles raw JSON lines (non-SSE fallback format)', async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          // Raw JSON without "data: " prefix
          controller.enqueue(encoder.encode('{"content": "raw"}\n'));
          controller.enqueue(encoder.encode('{"content": " json"}\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      fetchMock.mockResolvedValue({ ok: true, body });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([{ role: 'user', text: 'test' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      const texts: string[] = [];
      for await (const chunk of stream) {
        if (chunk.delta?.content) texts.push(chunk.delta.content);
      }

      expect(texts).toEqual(['raw', ' json']);
    });

    it('stops parsing after [DONE] even when data arrives in same chunk', async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          // [DONE] and a spurious data line arrive in the same chunk
          controller.enqueue(
            encoder.encode(
              'data: {"content": "valid"}\n\ndata: [DONE]\n\ndata: {"content": "after-done"}\n\n',
            ),
          );
          controller.close();
        },
      });

      fetchMock.mockResolvedValue({ ok: true, body });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([{ role: 'user', text: 'test' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      const texts: string[] = [];
      for await (const chunk of stream) {
        if (chunk.delta?.content) texts.push(chunk.delta.content);
      }

      // 'after-done' must NOT appear — parser must stop at [DONE]
      expect(texts).toEqual(['valid']);
    });

    it('sends request even when server returns an error status', async () => {
      // Verify the request is correctly formed; error should propagate via event.
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate Limited',
      });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([{ role: 'user', text: 'hi' }]);
      const stream = llmInstance.chat({ chatCtx: ctx as never });

      // The base class _mainTaskImpl emits errors on the LLM instance, then
      // rethrows.  The rethrow propagates as an unhandled rejection from the
      // fire-and-forget startSoon task — suppress it for test isolation.
      const suppress = () => {};
      process.on('unhandledRejection', suppress);

      let capturedError: Error | undefined;
      llmInstance.on('error', ({ error }: { error: Error }) => {
        capturedError = error;
      });

      // Drain the stream — iterator ends normally; errors propagate via event.
      for await (const _ of stream) { /* consume */ }

      // Flush pending microtasks so the rejection fires while our handler is active.
      await new Promise((r) => setTimeout(r, 0));
      process.off('unhandledRejection', suppress);

      expect(capturedError?.message).toContain('429');
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain('/v1/voicebot-call/bot/chat-conversion-stream');
    });

    it('captures options at chat creation time', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: makeSseBody(['ok']),
      });

      const llmInstance = new LLM({
        botId: 'bot',
        authToken: 'old-token',
        apiUrl: 'http://llm:8080',
        deepSearch: true,
        demographics: { gender: 'female', age: 30 },
      });
      const ctx = makeChatCtx([{ role: 'user', text: 'hi' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      llmInstance.updateOptions({
        authToken: 'new-token',
        deepSearch: false,
        demographics: { gender: 'male', age: 99 },
      });

      for await (const _ of stream) {
        /* consume */
      }

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('deep_search=true');
      expect(url).toContain('gender=female');
      expect(url).toContain('age=30');
      expect(url).not.toContain('gender=male');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer old-token' });
    });

    it('sends use_tool_based=true when enableTools is set', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: makeSseBody(['ok']),
      });

      const llmInstance = new LLM({
        botId: 'bot',
        authToken: 'tok',
        apiUrl: 'http://llm:8080',
        enableTools: true,
      });
      const ctx = makeChatCtx([{ role: 'user', text: 'test' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      for await (const _ of stream) { /* consume */ }

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain('use_tool_based=true');
    });

    it('sends use_tool_based=false by default', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: makeSseBody(['ok']),
      });

      const llmInstance = new LLM({ botId: 'bot', authToken: 'tok', apiUrl: 'http://llm:8080' });
      const ctx = makeChatCtx([{ role: 'user', text: 'test' }]);

      const stream = llmInstance.chat({ chatCtx: ctx as never });
      for await (const _ of stream) { /* consume */ }

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain('use_tool_based=false');
    });
  });
});
