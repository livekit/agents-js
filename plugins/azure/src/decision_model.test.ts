// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError, APIStatusError, llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionModel, type DecisionModelOptions } from './decision_model.js';

const URL = 'https://resource.example.invalid/providers/microsoft/v1/systemone';
const QUESTIONS = {
  human: new llm.Probability('The caller wants a human.'),
  intent: new llm.Choice('Intent?', { booking: 'Reservation', other: 'Other' }),
  frustration: new llm.Score('Frustration?', ['Calm', 'Annoyed', 'Angry']),
};
const ENVIRONMENT_NAMES = [
  'MICROSOFT_AI_DECISION_URL',
  'MICROSOFT_AI_DECISION_MODEL',
  'MICROSOFT_AI_DECISION_API_KEY',
  'MICROSOFT_AI_DECISION_AUTH_HEADER',
] as const;

afterEach(() => {
  for (const name of ENVIRONMENT_NAMES) delete process.env[name];
  vi.unstubAllGlobals();
});

function responseBody(): Record<string, unknown> {
  return {
    model: 'Microsoft-Decision-1',
    answers: {
      human: { type: 'noul', noul: 0.9 },
      intent: {
        type: 'choice',
        choice: 'booking',
        probabilities: { booking: 0.8, other: 0.2 },
        confidence: 0.5,
      },
      frustration: {
        type: 'score',
        score: 1.4,
        probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
        legend: { 0: 'Calm', 1: 'Annoyed', 2: 'Angry' },
        confidence: 0.1,
      },
    },
    usage: { input_tokens: 50, output_tokens: 5 },
  };
}

function modelFor(
  body: unknown,
  status = 200,
  options: Partial<DecisionModelOptions> = {},
): { model: DecisionModel; fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>> } {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
      }),
    ),
  );
  const model = new DecisionModel({
    url: URL,
    model: 'decision-deployment',
    apiKey: 'test-key',
    fetch,
    ...options,
  });
  return { model, fetch };
}

describe('Azure DecisionModel', () => {
  it('sends a batch to the deployment with an API key', async () => {
    const { model, fetch } = modelFor(responseBody());
    const context = llm.ChatContext.empty();
    context.addMessage({ role: 'user', content: 'Please book a table.' });

    await model.evaluate({ input: context, decisions: QUESTIONS });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(URL);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ 'api-key': 'test-key' });
    expect(init?.headers).not.toHaveProperty('Authorization');
    const payload = JSON.parse(String(init?.body));
    expect(payload.model).toBe('decision-deployment');
    expect(payload.state).toBe('user: Please book a table.');
    expect(payload.questions.human.type).toBe('noul');
    expect(payload.questions.intent.criteria).toEqual(QUESTIONS.intent.options);
    expect(payload.questions.frustration.criteria).toEqual(QUESTIONS.frustration.levels);
  });

  it('sends an Entra token as bearer authentication', async () => {
    const { model, fetch } = modelFor(responseBody(), 200, {
      apiKey: 'entra-token',
      authHeader: 'Authorization',
    });
    await model.evaluate({ input: '', decisions: QUESTIONS });
    const headers = fetch.mock.calls[0]?.[1]?.headers;
    expect(headers).toMatchObject({ Authorization: 'Bearer entra-token' });
    expect(headers).not.toHaveProperty('api-key');
  });

  it('reads configuration from the environment', async () => {
    setEnvironment('MICROSOFT_AI_DECISION_URL', URL);
    setEnvironment('MICROSOFT_AI_DECISION_MODEL', 'env-deployment');
    setEnvironment('MICROSOFT_AI_DECISION_API_KEY', 'env-key');
    const { fetch } = modelFor(responseBody());
    const model = new DecisionModel({ fetch });
    await model.evaluate({ input: '', decisions: QUESTIONS });
    expect(model.model).toBe('env-deployment');
    expect(model.provider).toBe('Microsoft AI');
    expect(fetch.mock.calls[0]?.[0]).toBe(URL);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ 'api-key': 'env-key' });
  });

  it.each([
    ['url', 'MICROSOFT_AI_DECISION_URL'],
    ['model', 'MICROSOFT_AI_DECISION_MODEL'],
    ['apiKey', 'MICROSOFT_AI_DECISION_API_KEY'],
  ] as const)('fails construction when %s configuration is missing', (missing, expected) => {
    const options: DecisionModelOptions = {
      url: URL,
      model: 'decision-deployment',
      apiKey: 'key',
    };
    delete options[missing];
    expect(() => new DecisionModel(options)).toThrow(expected);
  });

  it('rejects an insecure endpoint', () => {
    expect(
      () =>
        new DecisionModel({
          url: 'http://resource.example.invalid/providers/microsoft/v1/systemone',
          model: 'decision-deployment',
          apiKey: 'key',
        }),
    ).toThrow('TLS');
  });

  it('decodes every kind with distributions and usage', async () => {
    const { model } = modelFor(responseBody());
    const metrics = vi.fn();
    model.on('metrics_collected', metrics);

    const response = await model.evaluate({ input: '', decisions: QUESTIONS });

    expect(response.results.human?.value).toBe(0.9);
    expect(response.results.intent?.value).toBe('booking');
    expect(response.results.intent?.providerData.confidence).toBe(0.5);
    expect(response.results.frustration).toEqual({
      kind: 'score',
      value: 1.4,
      probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
      levels: ['Calm', 'Annoyed', 'Angry'],
      providerData: { confidence: 0.1 },
    });
    expect(response.errors).toEqual({});
    expect([response.model, response.provider]).toEqual(['Microsoft-Decision-1', 'Microsoft AI']);
    expect(response.requestId).toBe('request-1');
    expect([response.inputTokens, response.outputTokens]).toEqual([50, 5]);
    expect(metrics.mock.calls[0]?.[0].inputTokens).toBe(50);
    expect(metrics.mock.calls[0]?.[0].metadata.modelProvider).toBe('Microsoft AI');
  });

  it('reports an invalid answer without dropping the batch', async () => {
    const body = responseBody();
    const answers = body.answers as Record<string, Record<string, unknown>>;
    answers.intent!.choice = 'invented';
    const { model } = modelFor(body);

    const response = await model.evaluate({ input: '', decisions: QUESTIONS });

    expect(Object.keys(response.errors)).toEqual(['intent']);
    expect(Object.keys(response.results).sort()).toEqual(['frustration', 'human']);
  });

  it('rejects a batch with an unknown answer', async () => {
    const body = responseBody();
    const answers = body.answers as Record<string, unknown>;
    answers.unexpected = { type: 'noul', noul: 0.5 };
    const { model, fetch } = modelFor(body);
    await expect(model.evaluate({ input: '', decisions: QUESTIONS })).rejects.toBeInstanceOf(
      APIError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not retry authentication errors', async () => {
    const { model, fetch } = modelFor({}, 401);
    const promise = model.evaluate({
      input: '',
      decisions: QUESTIONS,
      connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    await expect(promise).rejects.toMatchObject({ statusCode: 401 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retries rate limits according to connection options', async () => {
    const { model, fetch } = modelFor({}, 429);
    await expect(
      model.evaluate({
        input: '',
        decisions: QUESTIONS,
        connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
      }),
    ).rejects.toBeInstanceOf(APIStatusError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-JSON success response', async () => {
    const { model, fetch } = modelFor({});
    fetch.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    const promise = model.evaluate({
      input: '',
      decisions: QUESTIONS,
      connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    await expect(promise).rejects.toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not close a borrowed client', async () => {
    const { model, fetch } = modelFor(responseBody());
    const close = vi.fn();
    Object.assign(fetch, { close });
    await model.aclose();
    expect(close).not.toHaveBeenCalled();
  });

  it('preserves a remote 499 and does not retry it', async () => {
    const { model, fetch } = modelFor({}, 499);
    const promise = model.evaluate({
      input: '',
      decisions: QUESTIONS,
      connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    await expect(promise).rejects.toMatchObject({ statusCode: 499 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('includes the Foundry body and request ID in errors', async () => {
    const body = { error: { code: 'DeploymentNotFound', message: 'No such deployment.' } };
    const { model, fetch } = modelFor(body, 404);
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 404,
        headers: { 'apim-request-id': 'apim-1' },
      }),
    );
    const error: unknown = await model
      .evaluate({ input: '', decisions: QUESTIONS })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({ requestId: 'apim-1' });
    expect((error as APIStatusError).body).toContain('DeploymentNotFound');
  });

  it('uses the built-in fetch by default', async () => {
    const { fetch } = modelFor(responseBody());
    vi.stubGlobal('fetch', fetch);
    const model = new DecisionModel({
      url: URL,
      model: 'decision-deployment',
      apiKey: 'test-key',
    });

    const response = await model.evaluate({ input: '', decisions: QUESTIONS });

    expect(Object.keys(response.results).sort()).toEqual(Object.keys(QUESTIONS).sort());
    expect(fetch).toHaveBeenCalledOnce();
  });
});

function setEnvironment(name: string, value: string): void {
  process.env[name] = value;
}
