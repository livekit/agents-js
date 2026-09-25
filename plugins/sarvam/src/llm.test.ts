// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, inference, llm } from '@livekit/agents';
import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  LLM,
  SARVAM_LLM_BASE_URL_V1,
  SARVAM_LLM_BASE_URL_V2,
  USER_AGENT,
  _filterExtraBody,
} from './llm.js';

interface LLMInternals {
  _client: OpenAI;
  _opts: {
    model: string;
    reasoningEffort?: string;
    extraHeaders: Record<string, string>;
    extraBody: Record<string, unknown>;
  };
}

interface StreamInternals {
  modelOptions: Record<string, unknown>;
}

const originalApiKey = process.env.SARVAM_API_KEY;
const fakeClient = () => ({}) as OpenAI;

function internals(model: LLM): LLMInternals {
  return model as unknown as LLMInternals;
}

function streamOptions(stream: inference.LLMStream): Record<string, unknown> {
  return (stream as unknown as StreamInternals).modelOptions;
}

function chatContext(text = 'hello'): llm.ChatContext {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: 'user', content: text });
  return ctx;
}

function chatContextWithImage(): llm.ChatContext {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({
    role: 'user',
    content: [
      'describe this image',
      llm.createImageContent({ image: 'data:image/png;base64,iVBORw0KGgo=' }),
    ],
  });
  return ctx;
}

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.SARVAM_API_KEY;
  else process.env.SARVAM_API_KEY = originalApiKey;
});

describe('Sarvam LLM model validation', () => {
  it('rejects an unsupported model', () => {
    expect(() => new LLM({ model: 'sarvam-unknown', apiKey: 'sk_test' })).toThrow(
      /Unsupported Sarvam model/,
    );
  });

  it('rejects the old sarvam-30b model', () => {
    expect(() => new LLM({ model: 'sarvam-30b', apiKey: 'sk_test' })).toThrow(
      /Unsupported Sarvam model/,
    );
  });

  for (const model of ['gemma4', 'sarvam-105b', 'sarvam-105b-conversations', 'glm5.2']) {
    it(`accepts ${model}`, () => {
      expect(new LLM({ model, apiKey: 'sk_test', client: fakeClient() }).model).toBe(model);
    });
  }

  it('defaults to sarvam-105b', () => {
    expect(new LLM({ apiKey: 'sk_test', client: fakeClient() }).model).toBe('sarvam-105b');
  });
});

describe('Sarvam LLM authentication and routing', () => {
  it('injects authentication headers', () => {
    const opts = internals(new LLM({ apiKey: 'sk_test', client: fakeClient() }))._opts;
    expect(opts.extraHeaders['api-subscription-key']).toBe('sk_test');
    expect(opts.extraHeaders['User-Agent']).toBe(USER_AGENT);
  });

  it('merges custom headers while enforcing Sarvam headers', () => {
    const opts = internals(
      new LLM({
        apiKey: 'sk_test',
        client: fakeClient(),
        extraHeaders: {
          'api-subscription-key': 'override_attempt',
          'User-Agent': 'override_attempt',
          'X-Custom': 'kept',
        },
      }),
    )._opts;
    expect(opts.extraHeaders).toMatchObject({
      'api-subscription-key': 'sk_test',
      'User-Agent': USER_AGENT,
      'X-Custom': 'kept',
    });
  });

  it('uses the v2 base URL by default', () => {
    expect(internals(new LLM({ apiKey: 'sk_test' }))._client.baseURL).toBe(SARVAM_LLM_BASE_URL_V2);
  });

  it('honors an explicit base URL', () => {
    expect(
      internals(new LLM({ apiKey: 'sk_test', baseURL: 'https://custom.sarvam.ai/v2' }))._client
        .baseURL,
    ).toBe('https://custom.sarvam.ai/v2');
  });
});

describe('Sarvam LLM request options', () => {
  it('filters unsupported extra body fields', () => {
    const opts = internals(
      new LLM({
        apiKey: 'sk_test',
        client: fakeClient(),
        extraBody: {
          max_tokens: 64,
          wiki_grounding: true,
          service_tier: 'flex',
          unknown_field: 'drop-me',
        },
      }),
    )._opts;
    expect(opts.extraBody).toEqual({ max_tokens: 64, wiki_grounding: true });
  });

  it('filters extra body fields directly', () => {
    expect(
      _filterExtraBody({
        max_tokens: 100,
        wiki_grounding: true,
        service_tier: 'flex',
        unknown: 'drop',
        n: 2,
      }),
    ).toEqual({ max_tokens: 100, wiki_grounding: true, n: 2 });
  });

  it('sets wiki grounding for supported models', () => {
    const opts = internals(
      new LLM({ apiKey: 'sk_test', client: fakeClient(), wikiGrounding: true }),
    )._opts;
    expect(opts.extraBody.wiki_grounding).toBe(true);
  });

  for (const [model, effort] of [
    ['sarvam-105b', 'high'],
    ['gemma4', 'low'],
    ['glm5.2', 'medium'],
  ] as const) {
    it(`sets reasoning effort for ${model}`, () => {
      const opts = internals(
        new LLM({ model, apiKey: 'sk_test', client: fakeClient(), reasoningEffort: effort }),
      )._opts;
      expect(opts.reasoningEffort).toBe(effort);
    });
  }

  it('omits reasoning effort by default', () => {
    expect(
      internals(new LLM({ apiKey: 'sk_test', client: fakeClient() }))._opts.reasoningEffort,
    ).toBeUndefined();
  });

  it('forwards core fields', () => {
    const model = new LLM({
      apiKey: 'sk_test',
      client: fakeClient(),
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 512,
      stop: ['END'],
      n: 2,
      seed: 42,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
    });
    const options = streamOptions(model.chat({ chatCtx: chatContext() }));
    expect(options).toMatchObject({
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 512,
      stop: ['END'],
      n: 2,
      seed: 42,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
    });
  });

  it('strips unsupported OpenAI fields from a stream', () => {
    const stream = new LLM({ apiKey: 'sk_test', client: fakeClient() }).chat({
      chatCtx: chatContext(),
      extraKwargs: {
        stream_options: { include_usage: true },
        max_completion_tokens: 10,
        service_tier: 'flex',
      },
    });
    const options = streamOptions(stream);
    expect(options.stream_options).toBeUndefined();
    expect(options).not.toHaveProperty('max_completion_tokens');
    expect(options).not.toHaveProperty('service_tier');
  });
});

describe('Sarvam LLM input validation', () => {
  for (const model of ['sarvam-105b', 'glm5.2', 'sarvam-105b-conversations']) {
    it(`rejects images for ${model}`, () => {
      const sarvam = new LLM({ model, apiKey: 'sk_test', client: fakeClient() });
      expect(() => sarvam.chat({ chatCtx: chatContextWithImage() })).toThrow(
        /Image input is not supported/,
      );
    });
  }

  it('accepts images for gemma4', () => {
    const stream = new LLM({ model: 'gemma4', apiKey: 'sk_test', client: fakeClient() }).chat({
      chatCtx: chatContextWithImage(),
    });
    expect(stream).toBeInstanceOf(inference.LLMStream);
  });

  it('skips non-message chat items during image validation', () => {
    const ctx = chatContext();
    ctx.insert(
      new llm.FunctionCallOutput({ callId: 'test_call', output: 'result', isError: false }),
    );
    expect(
      new LLM({ apiKey: 'sk_test', client: fakeClient() }).chat({ chatCtx: ctx }),
    ).toBeInstanceOf(inference.LLMStream);
  });

  it('rejects required tool choice without tools', () => {
    const sarvam = new LLM({ apiKey: 'sk_test', client: fakeClient() });
    expect(() => sarvam.chat({ chatCtx: chatContext(), toolChoice: 'required' })).toThrow(
      /toolChoice requires a non-empty tool context/,
    );
  });

  for (const toolChoice of ['none', 'auto'] as const) {
    it(`allows ${toolChoice} tool choice without tools`, () => {
      const stream = new LLM({ apiKey: 'sk_test', client: fakeClient() }).chat({
        chatCtx: chatContext(),
        toolChoice,
      });
      expect(stream).toBeInstanceOf(inference.LLMStream);
    });
  }

  it('allows tool choice with tools', () => {
    const getWeather = llm.tool({
      name: 'get_weather',
      description: 'Get the weather',
      parameters: z.object({ city: z.string() }),
      execute: async () => 'sunny',
    });
    const stream = new LLM({ apiKey: 'sk_test', client: fakeClient() }).chat({
      chatCtx: chatContext('weather?'),
      toolCtx: [getWeather],
      toolChoice: 'auto',
    });
    expect(stream).toBeInstanceOf(inference.LLMStream);
  });
});

describe('Sarvam LLM properties and API key', () => {
  it('uses Sarvam as provider', () => {
    expect(new LLM({ apiKey: 'sk_test', client: fakeClient() }).provider).toBe('Sarvam');
  });

  it('returns its model', () => {
    expect(new LLM({ model: 'gemma4', apiKey: 'sk_test', client: fakeClient() }).model).toBe(
      'gemma4',
    );
  });

  it('requires an API key', () => {
    delete process.env.SARVAM_API_KEY;
    expect(() => new LLM({ client: fakeClient() })).toThrow(/SARVAM_API_KEY is required/);
  });

  it('shares native inference stream status error behavior', async () => {
    const error = new APIStatusError({
      message: 'native provider error',
      options: {
        statusCode: 422,
        requestId: 'req_test',
        body: { error: 'bad request' },
        retryable: false,
      },
    });
    const run = vi
      .spyOn(inference.LLMStream.prototype as unknown as { run: () => Promise<void> }, 'run')
      .mockRejectedValueOnce(error);
    const stream = new LLM({ apiKey: 'sk_test', client: fakeClient() }).chat({
      chatCtx: chatContext(),
    });

    await expect((stream as unknown as { run: () => Promise<void> }).run()).rejects.toBe(error);
    expect(error.statusCode).toBe(422);
    expect(error.body).toEqual({ error: 'bad request' });
    run.mockRestore();
  });

  it('does not leak undefined values into extra body or headers', () => {
    const opts = internals(
      new LLM({ apiKey: 'sk_test', client: fakeClient(), wikiGrounding: true, maxTokens: 100 }),
    )._opts;
    expect(Object.values(opts.extraBody)).not.toContain(undefined);
    expect(Object.values(opts.extraHeaders)).not.toContain(undefined);
  });

  it('omits optional fields when unset', () => {
    const opts = internals(new LLM({ apiKey: 'sk_test', client: fakeClient() }))._opts;
    expect(opts.extraBody).not.toHaveProperty('wiki_grounding');
    expect(opts.reasoningEffort).toBeUndefined();
  });
});

describe('sarvam-105b-conversations capabilities', () => {
  it('routes conversations to v1', () => {
    const model = new LLM({ model: 'sarvam-105b-conversations', apiKey: 'sk_test' });
    expect(internals(model)._client.baseURL).toBe(SARVAM_LLM_BASE_URL_V1);
  });

  for (const model of ['sarvam-105b', 'gemma4', 'glm5.2']) {
    it(`routes ${model} to v2`, () => {
      expect(internals(new LLM({ model, apiKey: 'sk_test' }))._client.baseURL).toBe(
        SARVAM_LLM_BASE_URL_V2,
      );
    });
  }

  it('strips reasoning effort from options and streams', () => {
    const model = new LLM({
      model: 'sarvam-105b-conversations',
      apiKey: 'sk_test',
      client: fakeClient(),
      reasoningEffort: 'high',
    });
    expect(internals(model)._opts.reasoningEffort).toBeUndefined();
    expect(
      streamOptions(
        model.chat({ chatCtx: chatContext(), extraKwargs: { reasoning_effort: 'high' } }),
      ),
    ).not.toHaveProperty('reasoning_effort');
  });

  it('strips wiki grounding', () => {
    const opts = internals(
      new LLM({
        model: 'sarvam-105b-conversations',
        apiKey: 'sk_test',
        client: fakeClient(),
        wikiGrounding: true,
      }),
    )._opts;
    expect(opts.extraBody).not.toHaveProperty('wiki_grounding');
  });

  it('supports tool calling', () => {
    const getWeather = llm.tool({
      name: 'get_weather',
      description: 'Get the weather',
      parameters: z.object({ city: z.string() }),
      execute: async () => 'sunny',
    });
    const stream = new LLM({
      model: 'sarvam-105b-conversations',
      apiKey: 'sk_test',
      client: fakeClient(),
    }).chat({ chatCtx: chatContext(), toolCtx: [getWeather], toolChoice: 'auto' });
    expect(stream).toBeInstanceOf(inference.LLMStream);
  });

  it('honors an explicit conversations base URL', () => {
    const model = new LLM({
      model: 'sarvam-105b-conversations',
      apiKey: 'sk_test',
      baseURL: 'https://custom.sarvam.ai/v1',
    });
    expect(internals(model)._client.baseURL).toBe('https://custom.sarvam.ai/v1');
  });
});
