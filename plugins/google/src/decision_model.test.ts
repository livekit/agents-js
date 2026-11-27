// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { GoogleGenAI } from '@google/genai';
import {
  APIStatusError,
  ChatContext,
  Choice,
  type DecisionMetrics,
  Probability,
  Score,
} from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionModel } from './decision_model.js';

type AnswerBody = Record<string, unknown>;
interface ResponseBody {
  answers?: Record<string, AnswerBody>;
  error?: Record<string, string>;
  prompt_feedback?: Record<string, string>;
  usage?: Record<string, number>;
}

const questions = {
  human: new Probability('The caller wants a human.'),
  intent: new Choice('Intent?', { booking: 'Reservation', other: 'Other' }),
  frustration: new Score('Frustration?', ['Calm', 'Annoyed', 'Angry']),
};

function responseBody(): ResponseBody {
  return {
    answers: {
      human: { type: 'noul', noul: 0.9, confidence: 0.9 },
      intent: {
        type: 'choice',
        choice: 'booking',
        confidence: 0.8,
        probabilities: { booking: 0.8, other: 0.2 },
      },
      frustration: {
        type: 'score',
        score: 1.4,
        confidence: 0.5,
        probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
        legend: { '0': 'Calm', '1': 'Annoyed', '2': 'Angry' },
      },
    },
    usage: { total_input_tokens: 50, total_output_tokens: 5 },
  };
}

const handlers: Array<(request: Request) => Response | Promise<Response>> = [];
const client = new GoogleGenAI({
  apiKey: 'test-key',
  httpOptions: {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return handlers.at(-1)!(request);
    },
    retryOptions: { attempts: 1 },
  },
});

function modelFor(body: ResponseBody, status = 200): [DecisionModel, ResponseBody[]] {
  const requests: ResponseBody[] = [];
  handlers.push(async (request) => {
    expect(new URL(request.url).pathname).toBe('/v1beta/decisions');
    requests.push(JSON.parse(await request.text()) as ResponseBody);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
    });
  });
  return [new DecisionModel({ client }), requests];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DecisionModel', () => {
  it('sends a batch as questions keyed by name', async () => {
    const [model, requests] = modelFor(responseBody());
    const context = ChatContext.empty();
    context.addMessage({ role: 'user', content: 'Please book a table.' });

    await model.evaluate({ input: context, decisions: questions });

    expect(requests).toEqual([
      {
        model: 'gemini-decision-1',
        input: 'user: Please book a table.',
        questions: {
          human: { type: 'noul', instructions: 'The caller wants a human.' },
          intent: {
            type: 'choice',
            instructions: 'Intent?',
            criteria: { booking: 'Reservation', other: 'Other' },
          },
          frustration: {
            type: 'score',
            instructions: 'Frustration?',
            criteria: ['Calm', 'Annoyed', 'Angry'],
          },
        },
      },
    ]);
  });

  it('decodes every kind with distributions and usage', async () => {
    const [model, requests] = modelFor(responseBody());
    const metrics: DecisionMetrics[] = [];
    model.on('metrics_collected', (event) => metrics.push(event));

    const response = await model.evaluate({ input: '', decisions: questions });

    expect(requests).toHaveLength(1);
    const human = response.results.human!;
    expect([human.value, human.providerData.confidence]).toEqual([0.9, 0.9]);
    const choice = response.results.intent!;
    expect(choice.kind).toBe('choice');
    if (choice.kind !== 'choice') throw new Error('unreachable');
    expect([choice.value, choice.probabilities]).toEqual(['booking', { booking: 0.8, other: 0.2 }]);
    expect(choice.providerData.confidence).toBe(0.8);
    const score = response.results.frustration!;
    expect(score.kind).toBe('score');
    if (score.kind !== 'score') throw new Error('unreachable');
    expect([score.value, score.probabilities]).toEqual([1.4, { 0: 0.1, 1: 0.4, 2: 0.5 }]);
    expect(score.levels).toEqual(['Calm', 'Annoyed', 'Angry']);
    expect(response.errors).toEqual({});
    expect([response.model, response.provider]).toEqual(['gemini-decision-1', 'google']);
    expect([response.inputTokens, response.outputTokens]).toEqual([50, 5]);
    expect(metrics[0]!.inputTokens).toBe(50);
    expect(metrics[0]!.metadata!.modelProvider).toBe('google');
  });

  it.each([
    ['missing', 'human'],
    ['wrong_kind', 'human'],
    ['unknown_type', 'human'],
    ['non_numeric', 'human'],
    ['nan', 'human'],
    ['unknown_option', 'intent'],
    ['out_of_range_score', 'frustration'],
    ['shifted_levels', 'frustration'],
    ['unindexed_levels', 'frustration'],
    ['repeated_level', 'frustration'],
  ])('reports an invalid %s answer per decision', async (failure, broken) => {
    const body = responseBody();
    const answers = body.answers!;
    if (failure === 'missing') {
      delete answers.human;
    } else if (failure === 'wrong_kind') {
      answers.human = answers.intent!;
    } else if (failure === 'unknown_type') {
      answers.human = { type: 'rank', order: ['a'] };
    } else if (failure === 'non_numeric') {
      answers.human!.noul = 'likely';
    } else if (failure === 'nan') {
      answers.human!.noul = null;
    } else if (failure === 'unknown_option') {
      answers.intent!.choice = 'invented';
    } else if (failure === 'out_of_range_score') {
      answers.frustration!.score = 3.1;
    } else if (failure === 'shifted_levels') {
      answers.frustration!.probabilities = { '1': 0.1, '2': 0.4, '3': 0.5 };
    } else if (failure === 'unindexed_levels') {
      answers.frustration!.probabilities = { low: 0.1, mid: 0.4, high: 0.5 };
    } else {
      answers.frustration!.probabilities = { '0': 0.1, '00': 0.9, '1': 0.4, '2': 0.5 };
    }
    const [model, requests] = modelFor(body);

    const response = await model.evaluate({ input: '', decisions: questions });

    expect(Object.keys(response.errors)).toEqual([broken]);
    expect(Object.keys(response.results).sort()).toEqual(
      Object.keys(questions)
        .filter((name) => name !== broken)
        .sort(),
    );
    expect(response.inputTokens).toBe(50);
    expect(requests).toHaveLength(1);
  });

  it('rejects the batch when an answer names an unknown decision', async () => {
    const body = responseBody();
    body.answers!.invented = { type: 'noul', noul: 0.5, confidence: 0.5 };
    const [model] = modelFor(body);

    await expect(model.evaluate({ input: '', decisions: questions })).rejects.toThrow(
      'unknown decisions',
    );
  });

  it('rejects blocked input without retrying', async () => {
    const [model, requests] = modelFor({ prompt_feedback: { block_reason: 'safety' } });

    await expect(
      model.evaluate({
        input: '',
        decisions: questions,
        connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
      }),
    ).rejects.toThrow('blocked the decision input: safety');
    expect(requests).toHaveLength(1);
  });

  it('does not retry auth errors', async () => {
    const [model, requests] = modelFor({ error: { message: 'bad key' } }, 401);

    const error = await model
      .evaluate({
        input: '',
        decisions: questions,
        connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 },
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(401);
    expect(requests).toHaveLength(1);
  });

  it('retries server errors according to connection options', async () => {
    const [model, requests] = modelFor({ error: { message: 'overloaded' } }, 503);

    await expect(
      model.evaluate({
        input: '',
        decisions: questions,
        connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
      }),
    ).rejects.toBeInstanceOf(APIStatusError);
    expect(requests).toHaveLength(2);
  });

  it('fails at construction when the API key is missing', () => {
    vi.stubEnv('GOOGLE_API_KEY', '');
    expect(() => new DecisionModel()).toThrow('GOOGLE_API_KEY');
  });
});
