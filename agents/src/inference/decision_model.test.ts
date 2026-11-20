// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { TokenVerifier } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIError, APIStatusError } from '../_exceptions.js';
import { ChatContext } from '../llm/chat_context.js';
import { Choice, Probability, Score } from '../llm/decisions.js';
import { DecisionModel, type DecisionModelOptions } from './decision_model.js';

const BASE_URL = 'https://gateway.example/v1';
const CHECK = { check: new Probability('True?') };
const QUESTIONS = {
  ...CHECK,
  intent: new Choice('Intent?', { a: 'First', b: 'Second' }),
  grade: new Score('Grade?', ['Low', 'High']),
};
const RETRIES = { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 };

function responseBody() {
  return {
    id: 'body-id',
    model: 'jev-1.13.0',
    answers: {
      check: { type: 'noul', noul: 0.9 },
      intent: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.5 },
      grade: {
        type: 'score',
        score: 0.6,
        probabilities: { 0: 0.4, 1: 0.6 },
        legend: ['Low', 'High'],
      },
    },
    usage: { input_tokens: 1, output_tokens: 0 },
  };
}

function probabilityResponse(bodyModel?: string, fallbackModel?: string): Response {
  return Response.json(
    { model: bodyModel, answers: { check: responseBody().answers.check } },
    {
      headers: fallbackModel
        ? { 'X-LiveKit-Inference-Decisions-Model-Fallback': fallbackModel }
        : undefined,
    },
  );
}

function model(options: DecisionModelOptions = {}): DecisionModel {
  return new DecisionModel({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: BASE_URL,
    ...options,
  });
}

describe('inference.DecisionModel', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([true, false])(
    'resolves credentials with inference env set to %s',
    async (hasInferenceCredentials) => {
      vi.stubEnv(
        'LIVEKIT_INFERENCE_API_KEY',
        hasInferenceCredentials ? 'inference-key' : undefined,
      );
      vi.stubEnv(
        'LIVEKIT_INFERENCE_API_SECRET',
        hasInferenceCredentials ? 'inference-secret' : undefined,
      );
      vi.stubEnv('LIVEKIT_API_KEY', 'env-key');
      vi.stubEnv('LIVEKIT_API_SECRET', 'env-secret');
      const fetch = vi.fn<typeof globalThis.fetch>(async () => probabilityResponse());
      await model({ apiKey: undefined, apiSecret: undefined, fetch }).evaluate({
        input: '',
        decisions: CHECK,
      });
      const auth = new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization');
      const prefix = hasInferenceCredentials ? 'inference' : 'env';
      const verifier = new TokenVerifier(`${prefix}-key`, `${prefix}-secret`);
      await expect(verifier.verify(auth!.slice('Bearer '.length))).resolves.toMatchObject({
        inference: { perform: true },
      });
    },
  );

  it('requires an API key when credentials are absent', () => {
    vi.stubEnv('LIVEKIT_INFERENCE_API_KEY', undefined);
    vi.stubEnv('LIVEKIT_API_KEY', undefined);
    expect(() => model({ apiKey: undefined })).toThrow('apiKey is required');
  });

  it('reports its configured identity and supported decisions', () => {
    const decisionModel = model();
    expect(decisionModel.model).toBe('openai/gpt-6-luna-decisions');
    expect(decisionModel.provider).toBe('livekit');
    expect(decisionModel.capabilities.decisionKinds).toEqual(['probability', 'choice', 'score']);
  });

  it('posts the transcript and typed questions with a signed inference token', async () => {
    const body = responseBody();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          ...body,
          answers: {
            ...body.answers,
            check: { ...body.answers.check, provider_data: { ignored: true } },
            grade: { ...body.answers.grade, legend: { 0: 'Low', 1: 'High' } },
          },
        },
        { headers: { 'X-LiveKit-Request-Id': 'header-id' } },
      ),
    );
    const input = ChatContext.empty();
    input.addMessage({ role: 'user', content: 'Please book a table.' });
    const result = await model({ baseURL: `${BASE_URL}/`, fetch }).evaluate({
      input,
      decisions: QUESTIONS,
    });
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/decisions`);
    expect(request?.method).toBe('POST');
    const headers = new Headers(request?.headers);
    expect(headers.get('user-agent')).toMatch(/^livekit-agents-js\//);
    expect(headers.get('content-type')).toBe('application/json');
    const [scheme, token] = headers.get('authorization')!.split(' ');
    expect(scheme).toBe('Bearer');
    await expect(
      new TokenVerifier('test-key', 'test-secret').verify(token!),
    ).resolves.toMatchObject({
      inference: { perform: true },
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      model: 'openai/gpt-6-luna-decisions',
      state: 'user: Please book a table.',
      questions: {
        check: { type: 'noul', instructions: 'True?' },
        intent: { type: 'choice', instructions: 'Intent?', criteria: { a: 'First', b: 'Second' } },
        grade: { type: 'score', instructions: 'Grade?', criteria: ['Low', 'High'] },
      },
    });
    expect(result).toMatchObject({
      model: 'jev-1.13.0',
      provider: 'livekit',
      requestId: 'header-id',
      inputTokens: 1,
      outputTokens: 0,
      results: {
        check: { kind: 'probability', value: 0.9, providerData: {} },
        intent: {
          kind: 'choice',
          value: 'a',
          probabilities: { a: 0.8, b: 0.2 },
          providerData: { confidence: 0.5 },
        },
        grade: {
          kind: 'score',
          value: 0.6,
          probabilities: { 0: 0.4, 1: 0.6 },
          levels: ['Low', 'High'],
          providerData: { confidence: null },
        },
      },
    });
    expect(result.results.check?.providerData).toEqual({});
    expect(result.errors).toEqual({});
  });

  it('reports the configured model when the gateway does not identify the serving model', async () => {
    const result = await model({
      model: 'livekit/clef-omni',
      fetch: async () => probabilityResponse(),
    }).evaluate({ input: '', decisions: CHECK });
    expect(result.model).toBe('livekit/clef-omni');
  });

  it.each([
    [null, 0],
    [0, null],
  ] as const)('accepts nullable token counts (%s, %s)', async (inputTokens, outputTokens) => {
    const body = responseBody();
    const result = await model({
      fetch: async () =>
        Response.json({
          ...body,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }),
    }).evaluate({ input: '', decisions: QUESTIONS });
    expect(result.inputTokens).toBe(inputTokens ?? undefined);
    expect(result.outputTokens).toBe(outputTokens ?? undefined);
    expect(result.requestId).toBe('body-id');
  });

  it('decodes a positional score legend', async () => {
    const result = await model({ fetch: async () => Response.json(responseBody()) }).evaluate({
      input: '',
      decisions: QUESTIONS,
    });
    expect(result.errors).toEqual({});
    expect(result.results.grade).toMatchObject({ levels: ['Low', 'High'] });
  });

  it.each([
    [['Low'], 'score legend does not match distribution'],
    [['High', 'Low'], 'score distribution does not match levels'],
    [{ 1: 'Low', 2: 'High' }, 'score legend does not match distribution'],
  ] as const)('reports an invalid score legend %j per decision', async (legend, error) => {
    const body = responseBody();
    const result = await model({
      fetch: async () =>
        Response.json({
          ...body,
          answers: { ...body.answers, grade: { ...body.answers.grade, legend } },
        }),
    }).evaluate({ input: '', decisions: QUESTIONS });
    expect(result.errors).toEqual({ grade: error });
    expect(Object.keys(result.results)).toEqual(['check', 'intent']);
  });

  it.each([
    ['refusal', { type: 'refusal' }, 'the model declined this decision'],
    ['missing', undefined, 'missing decision answer'],
    ['malformed', { type: 'choice' }, 'invalid decision answer'],
    ['missing probabilities', { type: 'choice', choice: 'a' }, 'invalid decision answer'],
    [
      'invalid probabilities',
      { type: 'choice', choice: 'a', probabilities: [] },
      'invalid decision answer',
    ],
    ['wrong kind', { type: 'noul', noul: 0.5 }, 'wrong result kind'],
    ['unknown label', { ...responseBody().answers.intent, choice: 'invented' }, 'unknown choice'],
  ] as const)(
    'reports a %s answer without dropping the rest of the batch',
    async (_, intent, error) => {
      const body = responseBody();
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ ...body, answers: { ...body.answers, intent } }),
      );
      const result = await model({ fetch }).evaluate({ input: '', decisions: QUESTIONS });
      expect(result.errors).toEqual({ intent: error });
      expect(Object.keys(result.results)).toEqual(['check', 'grade']);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [{ type: 'noul', noul: 0.9 }, 'results', { kind: 'probability', value: 0.9, providerData: {} }],
    [{ type: 'refusal' }, 'errors', 'the model declined this decision'],
  ] as const)('keeps an answer named __proto__ with type %j', async (answer, field, value) => {
    const decisions = { ['__proto__']: CHECK.check };
    const fetch = async () => Response.json({ answers: { ['__proto__']: answer } });
    const result = await model({ fetch }).evaluate({ input: '', decisions });
    expect(Object.hasOwn(result[field], '__proto__')).toBe(true);
    expect(result[field]['__proto__']).toEqual(value);
  });

  it('rejects a batch containing an unknown answer', async () => {
    const body = responseBody();
    const fetch = async () =>
      Response.json({
        ...body,
        answers: { ...body.answers, unexpected: { type: 'noul', noul: 0.5 } },
      });
    await expect(model({ fetch }).evaluate({ input: '', decisions: QUESTIONS })).rejects.toThrow(
      'decision response contains unknown decisions',
    );
  });

  it.each([403, 503])(
    'surfaces a gateway %i error and applies its retry policy',
    async (status) => {
      const body = { type: 'gateway_error', error: 'service unavailable', hint: 'retry later' };
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(body, { status, headers: { 'X-LiveKit-Request-Id': 'header-id' } }),
      );
      const result = model({ fetch }).evaluate({
        input: '',
        decisions: CHECK,
        connOptions: RETRIES,
      });
      await expect(result).rejects.toBeInstanceOf(APIStatusError);
      await expect(result).rejects.toMatchObject({
        message: expect.stringContaining(body.error),
        statusCode: status,
        requestId: 'header-id',
        body,
      });
      expect(fetch).toHaveBeenCalledTimes(status === 403 ? 1 : 2);
    },
  );

  it.each([
    ['HTML', '<html>'],
    ['missing answers', '{}'],
    ['invalid usage', JSON.stringify({ ...responseBody(), usage: { input_tokens: -1 } })],
    ['invalid model', JSON.stringify({ ...responseBody(), model: 42 })],
    ['invalid request ID', JSON.stringify({ ...responseBody(), id: 42 })],
  ])('rejects a %s success response without retrying', async (_, body) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body));
    const result = model({ fetch }).evaluate({
      input: '',
      decisions: QUESTIONS,
      connOptions: RETRIES,
    });
    await expect(result).rejects.toBeInstanceOf(APIError);
    await expect(result).rejects.toMatchObject({
      message: 'invalid inference decision response',
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([200, 503])('retries a failed body read after HTTP %i headers', async (status) => {
    const interrupted = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('gateway connection closed'));
      },
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(interrupted, { status }))
      .mockImplementation(async () => probabilityResponse());

    const result = await model({ fetch }).evaluate({
      input: '',
      decisions: CHECK,
      connOptions: RETRIES,
    });
    expect(result.results.check?.value).toBe(0.9);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves caller cancellation during a body read', async () => {
    const abort = new AbortController();
    const reason = new Error('caller cancelled');
    const fetch = vi.fn<typeof globalThis.fetch>(async (_, request) => {
      const body = new ReadableStream(
        {
          pull(controller) {
            abort.abort(reason);
            controller.error(request?.signal?.reason);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body);
    });
    await expect(
      model({ fetch }).evaluate({
        input: '',
        decisions: CHECK,
        abortSignal: abort.signal,
        connOptions: RETRIES,
      }),
    ).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['typesafe/jev', [{ model: 'typesafe/jev' }]],
    [
      ['typesafe/jev', 'livekit/clef-omni'],
      [{ model: 'typesafe/jev' }, { model: 'livekit/clef-omni' }],
    ],
    [[], []],
  ] as const)('sends fallback models %j to the gateway', async (fallback, sent) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => probabilityResponse());
    await model({
      fallback: typeof fallback === 'string' ? fallback : [...fallback],
      fetch,
    }).evaluate({ input: '', decisions: CHECK });
    const request = fetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body.fallback).toEqual({ models: sent });
  });

  it.each([
    ['jev-1.13.0', 'jev-1.13.0'],
    [undefined, 'typesafe/jev'],
  ] as const)('reports the fallback model that answered', async (bodyModel, reported) => {
    const result = await model({
      fetch: async () => probabilityResponse(bodyModel, 'typesafe/jev'),
    }).evaluate({ input: '', decisions: CHECK });
    expect(result.model).toBe(reported);
  });
});
