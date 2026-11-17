// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import Anthropic from '@anthropic-ai/sdk';
import { type APIError, llm, voice } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';
import * as tools from './tools.js';

const searchCall: Anthropic.ServerToolUseBlock = {
  type: 'server_tool_use',
  id: 'srvtoolu_search',
  name: 'web_search',
  input: { query: 'LiveKit agents' },
};
const searchResult: Anthropic.WebSearchToolResultBlock = {
  type: 'web_search_tool_result',
  tool_use_id: searchCall.id,
  content: [
    {
      type: 'web_search_result',
      url: 'https://docs.livekit.io/agents/',
      title: 'LiveKit Agents',
      encrypted_content: 'opaque-search-content',
      page_age: null,
    },
  ],
};
const citation: Anthropic.TextCitation = {
  type: 'web_search_result_location',
  url: 'https://docs.livekit.io/agents/',
  title: 'LiveKit Agents',
  cited_text: 'Build voice agents',
  encrypted_index: 'opaque-citation-index',
};

function events(stopReason: Anthropic.StopReason = 'end_turn'): Anthropic.MessageStreamEvent[] {
  // The fixtures omit unrelated message envelope fields; content blocks use SDK types.
  return [
    {
      type: 'message_start',
      message: { id: 'msg_search', usage: { input_tokens: 10, output_tokens: 1 } },
    },
    { type: 'content_block_start', index: 0, content_block: { ...searchCall, input: {} } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(searchCall.input) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: searchResult },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '', citations: [] },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'Build voice agents.' },
    },
    { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ] as unknown as Anthropic.MessageStreamEvent[];
}

function setup(responses = [events()]) {
  const requests: Anthropic.MessageCreateParamsStreaming[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsStreaming) => {
        requests.push(params);
        return (async function* () {
          yield* responses.shift() ?? [];
        })();
      },
    },
  } as unknown as Anthropic;
  const model = new LLM({ client });
  const chatCtx = new llm.ChatContext();
  chatCtx.addMessage({ role: 'user', content: 'Find LiveKit agents' });
  return { model, chatCtx, requests };
}

describe('Anthropic web search', () => {
  it('sends native search and function tools together, and honors toolChoice none', async () => {
    const { model, chatCtx, requests } = setup([[], []]);
    const search = new tools.WebSearch({
      maxUses: 2,
      allowedDomains: ['livekit.io'],
      userLocation: { type: 'approximate', country: 'IN' },
    });
    const weather = llm.tool({
      name: 'weather',
      description: 'Weather',
      execute: async () => 'sunny',
    });
    await model.chat({ chatCtx, toolCtx: [search, weather] }).collect();
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({ name: weather.id, input_schema: expect.any(Object) }),
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 2,
        allowed_domains: ['livekit.io'],
        user_location: { type: 'approximate', country: 'IN' },
      },
    ]);
    await model.chat({ chatCtx, toolCtx: [search], toolChoice: 'none' }).collect();
    expect(requests[1]?.tools).toBeUndefined();
    await model.aclose();
  });
  it('preserves search results and citations without executing server tools locally', async () => {
    const { model, chatCtx, requests } = setup();
    const response = await model
      .chat({
        chatCtx,
        extraKwargs: { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      })
      .collect();
    expect(requests[0]?.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    expect(response.text).toBe('Build voice agents.');
    expect(response.toolCalls).toEqual([]);
    expect(response.extra).toEqual({
      anthropic: { serverTools: [searchCall, searchResult], citations: [citation] },
    });

    chatCtx.addMessage({ role: 'assistant', content: response.text, extra: response.extra });
    chatCtx.addMessage({ role: 'user', content: 'Tell me more' });
    await model.chat({ chatCtx }).collect();
    expect(requests[1]?.messages[1]).toEqual({
      role: 'assistant',
      content: [
        searchCall,
        searchResult,
        { type: 'text', text: response.text, citations: [citation] },
      ],
    });
    const assistant = chatCtx.items.find(
      (item) => item.type === 'message' && item.role === 'assistant',
    );
    if (assistant?.type !== 'message') throw new Error('Missing assistant message');
    assistant.extra = {
      anthropic: {
        ...(response.extra.anthropic as object),
        serverTools: [
          searchCall,
          searchResult,
          { ...searchCall, id: 'srvtoolu_interrupted', input: { query: 'unfinished search' } },
        ],
      },
    };
    assistant.interrupted = true;
    assistant.content = ['Build voice'];
    await model.chat({ chatCtx }).collect();
    expect(requests[2]?.messages[1]).toEqual({
      role: 'assistant',
      content: [
        searchCall,
        searchResult,
        { type: 'text', text: 'Build voice', citations: undefined },
      ],
    });
    await model.aclose();
  });

  it('delivers search state before spoken text so an interrupted reply retains its sources', async () => {
    const { model, chatCtx } = setup();
    const stream = model.chat({ chatCtx });
    let extra: Record<string, unknown> = {};
    for await (const chunk of stream) {
      if (chunk.delta?.extra) extra = { ...extra, ...chunk.delta.extra };
      if (chunk.delta?.content) {
        stream.close();
        break;
      }
    }
    expect(extra).toEqual({
      anthropic: { serverTools: [searchCall, searchResult], citations: [] },
    });
    await model.aclose();
  });

  it('continues paused searches with their original content and counts both requests', async () => {
    const paused = [
      ...events().slice(0, 4),
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ] as Anthropic.MessageStreamEvent[];
    const finished = [events()[0]!, ...events().slice(4)];
    const { model, chatCtx, requests } = setup([paused, finished]);
    const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    const response = await model.chat({ chatCtx, extraKwargs: { tools } }).collect();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toEqual({ role: 'assistant', content: [searchCall] });
    expect(requests[1]?.tools).toEqual(tools);
    expect(response.text).toBe('Build voice agents.');
    expect(response.extra).toEqual({
      anthropic: { serverTools: [searchCall, searchResult], citations: [citation] },
    });
    expect(response.usage?.promptTokens).toBe(20);
    expect(response.usage?.completionTokens).toBe(11);
    await model.aclose();
  });

  it('keeps pending server calls on a local function call even without assistant text', async () => {
    const mixed = [
      ...events().slice(0, 4),
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool_weather', name: 'weather', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"city":"London"}' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ] as Anthropic.MessageStreamEvent[];
    const { model, chatCtx, requests } = setup([mixed]);
    const response = await model.chat({ chatCtx }).collect();
    expect(response.text).toBe('');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.args).toBe('{"city":"London"}');
    expect(response.toolCalls[0]?.extra).toEqual({ anthropic: { serverTools: [searchCall] } });
    expect(
      (response.extra.anthropic as { serverTools?: unknown[] } | undefined)?.serverTools ?? [],
    ).toEqual([]);
    chatCtx.items.push(...response.toolCalls);
    chatCtx.items.push(
      llm.FunctionCallOutput.create({
        callId: 'tool_weather',
        name: 'weather',
        output: 'sunny',
        isError: false,
      }),
    );
    await model.chat({ chatCtx }).collect();
    expect(requests[1]?.messages[1]).toEqual({
      role: 'assistant',
      content: [
        searchCall,
        { type: 'tool_use', id: 'tool_weather', name: 'weather', input: { city: 'London' } },
      ],
    });
    await model.aclose();
  });
  it('does not lose a pending server call streamed after a local tool', async () => {
    const mixed = [
      events()[0],
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_weather', name: 'weather', input: {} },
      },
      { type: 'content_block_stop', index: 0 },
      ...events().slice(1, 4),
    ] as Anthropic.MessageStreamEvent[];
    const { model, chatCtx, requests } = setup([mixed]);
    const response = await model
      .chat({
        chatCtx,
        extraKwargs: { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      })
      .collect();
    chatCtx.items.push(...response.toolCalls);
    chatCtx.items.push(
      llm.FunctionCallOutput.create({
        callId: 'tool_weather',
        name: 'weather',
        output: 'sunny',
        isError: false,
      }),
    );
    await model.chat({ chatCtx }).collect();
    expect(requests[1]?.messages[1]?.content).toContainEqual(searchCall);
    await model.aclose();
  });

  it('cancels the provider request without resuming a paused search', async () => {
    let signal: AbortSignal | undefined;
    let requests = 0;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const client = {
      messages: {
        create: async (_params: unknown, options: { signal: AbortSignal }) => {
          requests++;
          signal = options.signal;
          return (async function* () {
            yield* events().slice(0, 8);
            await new Promise<void>((resolve) => {
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'pause_turn' },
              usage: { output_tokens: 8 },
            } as Anthropic.MessageStreamEvent;
            finish();
          })();
        },
      },
    } as unknown as Anthropic;
    const model = new LLM({ client });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Search' });
    const stream = model.chat({ chatCtx });
    for await (const chunk of stream) {
      if (chunk.delta?.content) {
        stream.close();
        break;
      }
    }
    await finished;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    expect(requests).toBe(1);
    await model.aclose();
  });

  it('keeps a real session open when request creation rejects on cancellation', async () => {
    vi.stubEnv('LIVEKIT_URL', '');
    let started!: () => void;
    const pendingRequest = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requests = 0;
    const client = new Anthropic({
      apiKey: 'offline-test',
      maxRetries: 0,
      fetch: async (url, options) => {
        if (new URL(url.toString()).pathname !== '/v1/messages') {
          return new Response(JSON.stringify({ data: [], has_more: false }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (++requests > 1) {
          return new Response(
            events()
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          const abort = () =>
            reject(new DOMException('Request cancelled before headers', 'AbortError'));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
          started();
        });
      },
    });
    const model = new LLM({ client });
    const errors = vi.fn();
    const closed = vi.fn();
    model.on('error', errors);
    const session = new voice.AgentSession({
      llm: model,
      vad: null,
      turnDetection: 'manual',
      connOptions: { maxUnrecoverableErrors: 0, llmConnOptions: { maxRetry: 0 } },
    });
    session.on(voice.AgentSessionEventTypes.Close, closed);
    try {
      await session.start({
        agent: new voice.Agent({ instructions: 'Answer briefly.' }),
        outputOptions: { audioEnabled: false },
      });
      const speech = session.generateReply({ userInput: 'Search' });
      await pendingRequest;
      speech.interrupt();
      await speech.waitForPlayout();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errors).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
      await session.generateReply({ userInput: 'Try again' }).waitForPlayout();
      expect(requests).toBe(2);
      expect(errors).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await model.aclose();
      vi.unstubAllEnvs();
    }
  });

  it('bounds pause continuations and never retries the original search', async () => {
    const { model, chatCtx, requests } = setup(
      Array.from({ length: 6 }, () => events('pause_turn')),
    );
    const errors: APIError[] = [];
    model.on('error', (event) => errors.push(event.error as APIError));
    await model
      .chat({ chatCtx, connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 } })
      .collect();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('remained paused');
    expect(errors[0]?.retryable).toBe(false);
    expect(requests).toHaveLength(5);
    await model.aclose();
  });

  it('handles real SDK SSE decoding, including search failures', async () => {
    const wireEvents = events();
    const failure = { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' };
    const failedResult = { ...searchResult, content: failure };
    wireEvents[4] = {
      type: 'content_block_start',
      index: 1,
      content_block: failedResult,
    } as Anthropic.MessageStreamEvent;
    const client = new Anthropic({
      apiKey: 'offline-test',
      fetch: async () =>
        new Response(
          wireEvents
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const model = new LLM({ client });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Search' });
    const response = await model.chat({ chatCtx }).collect();
    expect(response.extra).toEqual({
      anthropic: { serverTools: [searchCall, failedResult], citations: [citation] },
    });
    expect(response.toolCalls).toEqual([]);
    await model.aclose();
  });
});
