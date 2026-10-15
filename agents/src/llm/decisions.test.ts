// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { APIStatusError, APITimeoutError } from '../_exceptions.js';
import type { DecisionMetrics } from '../metrics/base.js';
import type { APIConnectOptions } from '../types.js';
import {
  AgentConfigUpdate,
  AgentHandoffItem,
  ChatContext,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
  createImageContent,
} from './chat_context.js';
import {
  Choice,
  ChoiceResult,
  type Decision,
  type DecisionKind,
  DecisionModel,
  DecisionResponse,
  type DecisionResult,
  Probability,
  ProbabilityResult,
  Score,
  ScoreResult,
  formatTranscript,
} from './decisions.js';

const QUESTIONS: Record<string, Decision> = {
  human: new Probability('The caller wants a human.'),
  intent: new Choice('Intent?', { booking: 'Reservation', other: 'Other' }),
  frustration: new Score('Frustration?', ['Calm', 'Annoyed', 'Angry']),
};

function validResults(): Record<string, DecisionResult> {
  return {
    human: new ProbabilityResult({ value: 0.9 }),
    intent: new ChoiceResult({
      value: 'booking',
      probabilities: { booking: 0.8, other: 0.2 },
    }),
    frustration: new ScoreResult({
      value: 1.4,
      probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
      levels: ['Calm', 'Annoyed', 'Angry'],
    }),
  };
}

class StaticModel extends DecisionModel {
  readonly outcomes: Array<DecisionResponse | Error>;
  readonly requests: Array<[string, Readonly<Record<string, Decision>>]> = [];

  constructor(...outcomes: Array<DecisionResponse | Error>);
  constructor(outcomes: Array<DecisionResponse | Error>, kinds: DecisionKind[]);
  constructor(
    outcomesOrFirst: Array<DecisionResponse | Error> | DecisionResponse | Error = [],
    ...rest: Array<DecisionResponse | Error | DecisionKind[]>
  ) {
    const hasKinds = Array.isArray(rest.at(-1));
    const kinds = hasKinds ? (rest.pop() as DecisionKind[]) : ['probability', 'choice', 'score'];
    super({ capabilities: { decisionKinds: kinds } });
    this.outcomes = Array.isArray(outcomesOrFirst)
      ? outcomesOrFirst
      : [outcomesOrFirst, ...(rest as Array<DecisionResponse | Error>)];
  }

  get model(): string {
    return 'configured-model';
  }

  get provider(): string {
    return 'test-provider';
  }

  protected async _evaluateImpl({
    input,
    decisions,
  }: {
    input: string;
    decisions: Readonly<Record<string, Decision>>;
    connOptions: APIConnectOptions;
    abortSignal: AbortSignal;
  }): Promise<DecisionResponse> {
    this.requests.push([input, decisions]);
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error('no queued outcome');
    return structuredClone(outcome);
  }
}

class HangingModel extends StaticModel {
  protected async _evaluateImpl({
    input,
    decisions,
    abortSignal,
  }: {
    input: string;
    decisions: Readonly<Record<string, Decision>>;
    connOptions: APIConnectOptions;
    abortSignal: AbortSignal;
  }): Promise<DecisionResponse> {
    this.requests.push([input, decisions]);
    return new Promise((_, reject) => {
      abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
    });
  }
}

async function evaluate(
  model: DecisionModel,
  options: {
    input?: string | ChatContext;
    decisions?: Readonly<Record<string, Decision>>;
    connOptions?: APIConnectOptions;
  } = {},
): Promise<DecisionResponse> {
  return model.evaluate({
    input: options.input ?? 'The caller asked for a table.',
    decisions: options.decisions ?? QUESTIONS,
    connOptions: options.connOptions,
  });
}

describe('DecisionModel', () => {
  it('reports results, usage, and identity once', async () => {
    const model = new StaticModel(
      new DecisionResponse({
        results: validResults(),
        model: 'resolved-model',
        requestId: 'request-1',
        inputTokens: 50,
        outputTokens: 5,
      }),
    );
    const collected: DecisionMetrics[] = [];
    model.on('metrics_collected', (metrics) => collected.push(metrics));
    const response = await evaluate(model);

    expect(Object.keys(response.results)).toEqual(Object.keys(QUESTIONS));
    expect(response.errors).toEqual({});
    expect([response.model, response.provider]).toEqual(['resolved-model', 'test-provider']);
    const [[, definitions]] = model.requests;
    expect(definitions).toEqual(QUESTIONS);
    const [metrics] = collected;
    expect(metrics?.type).toBe('decision_metrics');
    expect([metrics?.inputTokens, metrics?.outputTokens]).toEqual([50, 5]);
    expect(metrics?.requestId).toBe('request-1');
    expect(metrics?.metadata?.modelName).toBe('resolved-model');
    expect(metrics?.metadata?.modelProvider).toBe('test-provider');
  });

  it('falls back to the configured model identity', async () => {
    const response = await evaluate(
      new StaticModel(new DecisionResponse({ results: validResults() })),
    );
    expect([response.model, response.provider]).toEqual(['configured-model', 'test-provider']);
  });

  it('copies definitions before passing them to the provider', async () => {
    const model = new StaticModel(new DecisionResponse({ results: validResults() }));
    await evaluate(model);
    const [[, definitions]] = model.requests;
    expect(definitions).not.toBe(QUESTIONS);
    expect((definitions?.intent as Choice).options).not.toBe((QUESTIONS.intent as Choice).options);
  });

  it.each<[string, DecisionResult, string]>([
    ['human', new ChoiceResult({ value: 'booking' }), 'wrong result kind'],
    ['intent', new ChoiceResult({ value: 'invented' }), 'unknown choice'],
    [
      'intent',
      new ChoiceResult({ value: 'booking', probabilities: { booking: 1 } }),
      'choice distribution does not match options',
    ],
    [
      'intent',
      new ChoiceResult({ value: 'other', probabilities: { booking: 0.8, other: 0.2 } }),
      'choice is not a most probable option',
    ],
    [
      'frustration',
      new ScoreResult({
        value: 1,
        probabilities: { 0: 0.5, 1: 0.5 },
        levels: ['Calm', 'Annoyed'],
      }),
      'score distribution does not match levels',
    ],
    [
      'frustration',
      new ScoreResult({
        value: 2.5,
        probabilities: { 0: 0, 1: 0, 2: 1 },
        levels: ['Calm', 'Annoyed', 'Angry'],
      }),
      'score is outside the defined scale',
    ],
  ])('reports an invalid %s answer without dropping the batch', async (name, result, error) => {
    const results = validResults();
    results[name] = result;
    const response = await evaluate(new StaticModel(new DecisionResponse({ results })));
    expect(response.errors).toEqual({ [name]: error });
    expect(Object.keys(response.results).sort()).toEqual(
      Object.keys(QUESTIONS)
        .filter((key) => key !== name)
        .sort(),
    );
  });

  it('reports missing answers per decision', async () => {
    const results = validResults();
    delete results.human;
    delete results.intent;
    const response = await evaluate(
      new StaticModel(new DecisionResponse({ results, errors: { intent: 'provider refused' } })),
    );
    expect(response.errors).toEqual({
      human: 'missing decision answer',
      intent: 'provider refused',
    });
    expect(Object.keys(response.results)).toEqual(['frustration']);
  });

  it('does not enforce provider rounding', async () => {
    const results = validResults();
    results.intent = new ChoiceResult({
      value: 'booking',
      probabilities: { booking: 0.9, other: 0.3 },
    });
    results.frustration = new ScoreResult({
      value: 0.2,
      probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
      levels: ['Calm', 'Annoyed', 'Angry'],
    });
    const response = await evaluate(new StaticModel(new DecisionResponse({ results })));
    expect(response.errors).toEqual({});
    expect(Object.keys(response.results)).toEqual(Object.keys(QUESTIONS));
  });

  it.each(['unknown decisions', 'both a result and an error'])(
    'raises for malformed responses containing %s after reporting usage',
    async (failure) => {
      const response = new DecisionResponse({
        results: validResults(),
        inputTokens: 50,
        outputTokens: 5,
      });
      if (failure === 'unknown decisions') {
        response.results.extra = new ProbabilityResult({ value: 0.5 });
      } else {
        response.errors.human = 'invalid answer';
      }
      const model = new StaticModel(response);
      const collected: DecisionMetrics[] = [];
      model.on('metrics_collected', (metrics) => collected.push(metrics));
      await expect(evaluate(model)).rejects.toThrow(failure);
      expect([collected[0]?.inputTokens, collected[0]?.outputTokens]).toEqual([50, 5]);
    },
  );

  it('obeys connection options for retryable errors', async () => {
    const model = new StaticModel(
      new APIStatusError({ message: 'unavailable', options: { statusCode: 503 } }),
      new DecisionResponse({ results: validResults() }),
    );
    const response = await evaluate(model, {
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    expect(model.requests).toHaveLength(2);
    expect(response.errors).toEqual({});
  });

  it('does not retry non-retryable errors', async () => {
    const model = new StaticModel(
      new APIStatusError({ message: 'unauthorized', options: { statusCode: 401 } }),
    );
    await expect(
      evaluate(model, { connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 } }),
    ).rejects.toBeInstanceOf(APIStatusError);
    expect(model.requests).toHaveLength(1);
  });

  it.each([0, 1])(
    'preserves retry count and cause on timeout with maxRetry=%i',
    async (maxRetry) => {
      const model = new HangingModel();
      const collected: DecisionMetrics[] = [];
      model.on('metrics_collected', (metrics) => collected.push(metrics));
      let error: unknown;
      try {
        await evaluate(model, {
          decisions: { check: new Probability('True?') },
          connOptions: { maxRetry, retryIntervalMs: 0, timeoutMs: 10 },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(APITimeoutError);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(model.requests).toHaveLength(maxRetry + 1);
      expect(collected).toEqual([]);
    },
  );

  it('skips the provider for an empty batch', async () => {
    const model = new StaticModel();
    const response = await evaluate(model, { decisions: {} });
    expect(response.results).toEqual({});
    expect(model.requests).toEqual([]);
  });

  it('fails before the provider request for an unsupported kind', async () => {
    const model = new StaticModel([], ['probability']);
    await expect(evaluate(model)).rejects.toThrow('does not support');
    expect(model.requests).toEqual([]);
  });

  it.each<[Decision, string]>([
    [new Probability('  '), 'non-empty prompt'],
    [new Choice('Intent?', { only: 'One option' }), 'at least two named'],
    [new Score('Level?', ['Only']), 'at least two described'],
  ])('fails before the provider request for invalid definitions', async (definition, error) => {
    const model = new StaticModel();
    await expect(evaluate(model, { decisions: { check: definition } })).rejects.toThrow(error);
    expect(model.requests).toEqual([]);
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'requires finite bounded probabilities (%s)',
    (value) => {
      expect(() => new ProbabilityResult({ value })).toThrow();
    },
  );

  it('sends string input as-is', async () => {
    const model = new StaticModel(new DecisionResponse({ results: validResults() }));
    await evaluate(model, { input: '  Caller: I want a refund.\n' });
    expect(model.requests[0]?.[0]).toBe('  Caller: I want a refund.\n');
  });

  it('sends chat context input as a transcript', async () => {
    const context = ChatContext.empty();
    context.addMessage({ role: 'user', content: 'Book a table, please.' });
    context.addMessage({ role: 'assistant', content: 'For how many?' });
    const model = new StaticModel(new DecisionResponse({ results: validResults() }));
    await evaluate(model, { input: context });
    expect(model.requests[0]?.[0]).toBe('user: Book a table, please.\nassistant: For how many?');
  });
});

function conversation(): ChatContext {
  return new ChatContext([
    new ChatMessage({ role: 'system', content: ['Answer only in Spanish.'] }),
    new ChatMessage({ role: 'developer', content: ['Internal instructions.'] }),
    new AgentConfigUpdate({ instructions: 'More internal instructions.' }),
    new ChatMessage({
      role: 'user',
      content: ['Book a table.', createImageContent({ image: 'https://example.com/image.png' })],
    }),
    new FunctionCall({ callId: 'call-1', name: 'book', args: '{"party_size": 2}' }),
    new FunctionCallOutput({
      callId: 'call-1',
      name: 'book',
      output: 'No tables',
      isError: true,
    }),
    new AgentHandoffItem({ oldAgentId: 'booking', newAgentId: 'receptionist' }),
    new ChatMessage({
      role: 'assistant',
      content: ['<expr value="warm"/>I can offer seven.'],
      interrupted: true,
    }),
  ]);
}

describe('formatTranscript', () => {
  it('keeps only user and assistant text by default', () => {
    expect(formatTranscript(conversation())).toBe(
      'user: Book a table.\nassistant: I can offer seven.',
    );
  });

  it('includes context events when requested', () => {
    expect(formatTranscript(conversation(), { includeContextEvents: true })).toBe(
      'user: Book a table.\n' +
        '[function call: book({"party_size": 2})]\n' +
        '[function error: No tables]\n' +
        '[agent handoff: booking -> receptionist]\n' +
        'assistant: I can offer seven. [interrupted]',
    );
  });
});
