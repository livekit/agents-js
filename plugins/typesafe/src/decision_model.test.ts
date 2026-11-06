// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError, APIStatusError, llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionModel } from './decision_model.js';

const QUESTIONS: Record<string, llm.Decision> = {
  human: new llm.Probability('The caller wants a human.'),
  intent: new llm.Choice('Intent?', { booking: 'Reservation', other: 'Other' }),
  frustration: new llm.Score('Frustration?', ['Calm', 'Annoyed', 'Angry']),
};

interface TestAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  score?: number;
  legend?: Record<string, string>;
}

interface TestResponseBody {
  model?: string;
  answers: Record<string, TestAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface TestPayload {
  model: string;
  state: string;
  questions: Record<string, { type: string; criteria?: unknown }>;
}

function responseBody(): TestResponseBody {
  return {
    model: 'typesafe/jev-1.13.0',
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
  {
    status = 200,
    jsonError,
    cancel = vi.fn(async () => {}),
  }: { status?: number; jsonError?: Error; cancel?: ReturnType<typeof vi.fn> } = {},
): [DecisionModel, ReturnType<typeof vi.fn>] {
  const fetchMock = vi.fn(async () => ({
    ok: status < 400,
    status,
    headers: new Headers({ 'x-request-id': 'request-1' }),
    body: { cancel },
    json: async () => {
      if (jsonError) throw jsonError;
      return body;
    },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return [DecisionModel.withOpenRouter({ apiKey: 'test-key' }), fetchMock];
}

function payload(fetchMock: ReturnType<typeof vi.fn>): TestPayload {
  return JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as TestPayload;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('DecisionModel', () => {
  it('uses the TypeSafe endpoint, configured model, and environment key', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'env-key');
    const [, fetchMock] = modelFor(responseBody());
    const model = new DecisionModel({ model: 'jev-1.13.0' });
    const response = await model.evaluate({ input: '', decisions: QUESTIONS });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.typesafe.ai/v1/systemone');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer env-key',
    });
    expect(payload(fetchMock).model).toBe('jev-1.13.0');
    expect([model.model, model.provider]).toEqual(['jev-1.13.0', 'typesafe']);
    expect(response.provider).toBe('typesafe');
  });

  it('fails at construction when the API key is missing', () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => new DecisionModel()).toThrow('TYPESAFE_API_KEY');
    expect(() => DecisionModel.withOpenRouter()).toThrow('OPENROUTER_API_KEY');
  });

  it('batches every kind and preserves distributions and usage', async () => {
    const [model, fetchMock] = modelFor(responseBody());
    const context = llm.ChatContext.empty();
    context.addMessage({ role: 'user', content: 'Please book a table.' });
    const metrics: unknown[] = [];
    model.on('metrics_collected', (event) => metrics.push(event));
    const response = await model.evaluate({ input: context, decisions: QUESTIONS });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/alpha/decisions');
    const request = payload(fetchMock);
    expect(request.model).toBe('typesafe/jev-1.13');
    expect(request.state).toBe('user: Please book a table.');
    expect(request.questions.human!.type).toBe('noul');
    expect(request.questions.intent!.criteria).toEqual((QUESTIONS.intent as llm.Choice).options);
    expect(request.questions.frustration!.criteria).toEqual(
      (QUESTIONS.frustration as llm.Score).levels,
    );
    expect(response.results.human?.value).toBe(0.9);
    expect(response.results.intent?.value).toBe('booking');
    expect(response.results.intent?.providerData.confidence).toBe(0.5);
    const score = response.results.frustration as llm.ScoreResult;
    expect(score.kind).toBe('score');
    expect(score.value).toBe(1.4);
    expect(score.probabilities).toEqual({ 0: 0.1, 1: 0.4, 2: 0.5 });
    expect(response.requestId).toBe('request-1');
    expect(response.model).toBe('typesafe/jev-1.13.0');
    expect(response.provider).toBe('openrouter');
    expect(response.errors).toEqual({});
    expect(metrics[0]).toMatchObject({
      inputTokens: 50,
      metadata: { modelName: response.model, modelProvider: 'openrouter' },
    });
  });

  it.each([
    [1.07, { 0: 0, 1: 0.92, 2: 0.08 }],
    [1, { 0: 0.33, 1: 0.33, 2: 0.33 }],
    [1.4, { 0: 0.01, 1: 0.59, 2: 0.41 }],
  ])('preserves a rounded score and its whole batch', async (value, probabilities) => {
    const body = responseBody();
    Object.assign(body.answers.frustration!, { score: value, probabilities });
    const [model, fetchMock] = modelFor(body);
    const response = await model.evaluate({ input: '', decisions: QUESTIONS });
    expect(Object.keys(response.results)).toEqual(Object.keys(QUESTIONS));
    const result = response.results.frustration as llm.ScoreResult;
    expect(result.kind).toBe('score');
    expect(result.value).toBe(value);
    expect(result.probabilities).toEqual(probabilities);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves a rounded choice distribution', async () => {
    const body = responseBody();
    body.answers.intent!.probabilities = { booking: 0.66, other: 0.33 };
    const [model] = modelFor(body);
    const response = await model.evaluate({ input: '', decisions: QUESTIONS });
    expect((response.results.intent as llm.ChoiceResult).probabilities).toEqual({
      booking: 0.66,
      other: 0.33,
    });
  });

  it('includes level weights when preserving five-level score rounding', async () => {
    const body = responseBody();
    Object.assign(body.answers.frustration!, {
      score: 1.95,
      probabilities: { 0: 0.2, 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.18 },
    });
    const questions = {
      ...QUESTIONS,
      frustration: new llm.Score('Frustration?', ['Calm', 'Uneasy', 'Annoyed', 'Angry', 'Furious']),
    };
    body.answers.frustration!.legend = Object.fromEntries(
      questions.frustration.levels.map((level, index) => [index, level]),
    );
    const [model] = modelFor(body);
    const response = await model.evaluate({ input: '', decisions: questions });
    expect(Object.keys(response.results)).toEqual(Object.keys(questions));
    expect(response.results.frustration?.value).toBe(1.95);
  });

  it.each([
    ['missing', 'human'],
    ['wrong kind', 'human'],
    ['unknown label', 'intent'],
    ['out of range score', 'frustration'],
    ['nan', 'human'],
  ])('reports an invalid %s answer without dropping the batch', async (failure, broken) => {
    const body = responseBody();
    if (failure === 'missing') delete body.answers.human;
    else if (failure === 'wrong kind') body.answers.human = body.answers.intent!;
    else if (failure === 'unknown label') body.answers.intent!.choice = 'invented';
    else if (failure === 'out of range score') {
      Object.assign(body.answers.frustration!, {
        score: 2.01,
        probabilities: { 0: 0, 1: 0, 2: 1 },
      });
    } else body.answers.human!.noul = Number.NaN;
    const [model, fetchMock] = modelFor(body);
    const response = await model.evaluate({ input: '', decisions: QUESTIONS });
    expect(Object.keys(response.errors)).toEqual([broken]);
    expect(Object.keys(response.results).sort()).toEqual(
      Object.keys(QUESTIONS)
        .filter((name) => name !== broken)
        .sort(),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects the batch when it contains an unknown answer', async () => {
    const body = responseBody();
    body.answers.unexpected = { type: 'noul', noul: 0.5 };
    const [model, fetchMock] = modelFor(body);
    await expect(model.evaluate({ input: '', decisions: QUESTIONS })).rejects.toBeInstanceOf(
      APIError,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry authentication errors', async () => {
    const [model, fetchMock] = modelFor({}, { status: 401 });
    let error: unknown;
    try {
      await model.evaluate({ input: '', decisions: QUESTIONS });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry a non-JSON success response', async () => {
    const [model, fetchMock] = modelFor({}, { jsonError: new SyntaxError('text/html') });
    let error: unknown;
    try {
      await model.evaluate({
        input: '',
        decisions: QUESTIONS,
        connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('cancels the body of every error response', async () => {
    const cancel = vi.fn(async () => {});
    const [model, fetchMock] = modelFor({}, { status: 503, cancel });
    await expect(
      model.evaluate({
        input: '',
        decisions: QUESTIONS,
        connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
      }),
    ).rejects.toBeInstanceOf(APIStatusError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it('keeps answers for decisions named __proto__', async () => {
    const decisions = Object.fromEntries([['__proto__', new llm.Probability('Ready?')]]);
    const [model] = modelFor(
      JSON.parse('{"answers": {"__proto__": {"type": "noul", "noul": 0.7}}}'),
    );
    const response = await model.evaluate({ input: '', decisions });
    expect(Object.hasOwn(response.results, '__proto__')).toBe(true);
    expect(response.errors).toEqual({});
  });

  it('obeys connection options for retryable errors', async () => {
    const [model, fetchMock] = modelFor({}, { status: 503 });
    await expect(
      model.evaluate({
        input: '',
        decisions: QUESTIONS,
        connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
      }),
    ).rejects.toBeInstanceOf(APIStatusError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'malformed', 'wrong kind'])(
    'preserves valid answers and usage when one answer is %s',
    async (failure) => {
      const body = responseBody();
      if (failure === 'missing') delete body.answers.frustration;
      else if (failure === 'malformed') body.answers.frustration = { type: 'score' };
      else body.answers.frustration = { type: 'noul', noul: 0.5 };
      const [model, fetchMock] = modelFor(body);
      const response = await model.evaluate({ input: '', decisions: QUESTIONS });
      expect(Object.keys(response.results)).toEqual(['human', 'intent']);
      expect(Object.keys(response.errors)).toEqual(['frustration']);
      expect(response.errors.frustration).toBeTruthy();
      expect(response.inputTokens).toBe(50);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, { 0: 'Angry', 1: 'Annoyed', 2: 'Calm' }])(
    'rejects a missing or mismatched legend',
    async (legend) => {
      const body = responseBody();
      if (legend === undefined) delete body.answers.frustration!.legend;
      else body.answers.frustration!.legend = legend;
      const [model] = modelFor(body);
      const response = await model.evaluate({ input: '', decisions: QUESTIONS });
      expect(Object.keys(response.errors)).toEqual(['frustration']);
      expect(Object.keys(response.results)).toEqual(['human', 'intent']);
    },
  );

  it('does not let legend key order change level order', async () => {
    const body = responseBody();
    body.answers.frustration!.legend = { 2: 'Angry', 0: 'Calm', 1: 'Annoyed' };
    const [model] = modelFor(body);
    const response = await model.evaluate({ input: '', decisions: QUESTIONS });
    expect((response.results.frustration as llm.ScoreResult).levels).toEqual([
      'Calm',
      'Annoyed',
      'Angry',
    ]);
  });

  it.each([false, true])('does not allow score legends to shift level indices', async (shift) => {
    const body = responseBody();
    body.answers.frustration!.legend = { 1: 'Calm', 2: 'Annoyed', 3: 'Angry' };
    if (shift) body.answers.frustration!.probabilities = { 1: 0.1, 2: 0.4, 3: 0.5 };
    const [model] = modelFor(body);
    const response = await model.evaluate({ input: '', decisions: QUESTIONS });
    expect(Object.keys(response.errors)).toEqual(['frustration']);
  });

  it('falls back to the configured model identity', async () => {
    const body = responseBody();
    delete body.model;
    const [model] = modelFor(body);
    const response = await model.evaluate({ input: '', decisions: QUESTIONS });
    expect([response.model, response.provider]).toEqual([model.model, model.provider]);
  });

  it('reports every missing answer per decision', async () => {
    const [model] = modelFor({ answers: {} });
    const response = await model.evaluate({ input: '', decisions: QUESTIONS });
    expect(response.results).toEqual({});
    expect(Object.keys(response.errors).sort()).toEqual(Object.keys(QUESTIONS).sort());
  });

  it.each([{}, { answers: [] }, { answers: { unknown: null } }])(
    'rejects an invalid batch structure',
    async (body) => {
      const [model] = modelFor(body);
      await expect(model.evaluate({ input: '', decisions: QUESTIONS })).rejects.toBeInstanceOf(
        APIError,
      );
    },
  );

  it('sends text input as state', async () => {
    const [model, fetchMock] = modelFor(responseBody());
    await model.evaluate({ input: '{"ticket": "Refund please"}', decisions: QUESTIONS });
    expect(payload(fetchMock).state).toBe('{"ticket": "Refund please"}');
  });

  it('sends conversations without instructions or media', async () => {
    const context = new llm.ChatContext([
      new llm.ChatMessage({ role: 'system', content: ['Answer only in Spanish.'] }),
      new llm.ChatMessage({ role: 'developer', content: ['Internal instructions.'] }),
      new llm.AgentConfigUpdate({ instructions: 'More internal instructions.' }),
      new llm.ChatMessage({
        role: 'user',
        content: [
          'Book a table.',
          llm.createImageContent({ image: 'https://example.com/image.png' }),
          { type: 'audio_content', frame: [] } as unknown as llm.AudioContent,
        ],
      }),
      new llm.FunctionCall({ callId: 'call-1', name: 'book', args: '{"party_size": 2}' }),
      new llm.FunctionCallOutput({
        callId: 'call-1',
        name: 'book',
        output: 'No tables',
        isError: false,
      }),
      new llm.AgentHandoffItem({ oldAgentId: 'booking', newAgentId: 'receptionist' }),
      new llm.ChatMessage({
        role: 'assistant',
        content: ['<expr value="warm"/>I can offer'],
        interrupted: true,
      }),
    ]);
    const [model, fetchMock] = modelFor(responseBody());
    await model.evaluate({ input: context, decisions: QUESTIONS });
    expect(payload(fetchMock).state).toBe('user: Book a table.\nassistant: I can offer');
    expect(context.items).toHaveLength(8);
    expect((context.items[3] as llm.ChatMessage).content).toHaveLength(3);
  });
});
