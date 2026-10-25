// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  isAPIError,
  llm,
} from '@livekit/agents';
import type { DecisionModels, OpenRouterDecisionModels } from './models.js';

const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

type Question =
  | { instructions: string; type: 'noul' }
  | { criteria: Record<string, string>; instructions: string; type: 'choice' }
  | { criteria: string[]; instructions: string; type: 'score' };

interface JevResponse {
  answers: Record<string, unknown>;
  id?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface DecisionModelOptions {
  /** TypeSafe model identifier. */
  model?: DecisionModels | string;
  /** Defaults to `TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Complete HTTP endpoint for batched decisions. */
  endpoint?: string;
}

/** TypeSafe Jev, via the TypeSafe API or {@link DecisionModel.withOpenRouter}. */
export class DecisionModel extends llm.DecisionModel {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #endpoint: string;
  #provider = 'typesafe';

  constructor({
    model = 'jev-1.13.0',
    apiKey = process.env.TYPESAFE_API_KEY,
    endpoint = TYPESAFE_ENDPOINT,
  }: DecisionModelOptions = {}) {
    super({ capabilities: { decisionKinds: ['probability', 'choice', 'score'] } });
    if (!apiKey) throw new Error('TypeSafe requires apiKey or TYPESAFE_API_KEY');
    this.#apiKey = apiKey;
    this.#model = model;
    this.#endpoint = endpoint;
  }

  /** Use OpenRouter's Decisions API. `apiKey` defaults to `OPENROUTER_API_KEY`. */
  static withOpenRouter({
    model = 'typesafe/jev-1.13',
    apiKey = process.env.OPENROUTER_API_KEY,
  }: {
    model?: OpenRouterDecisionModels | string;
    apiKey?: string;
  } = {}): DecisionModel {
    if (!apiKey) {
      throw new Error('TypeSafe via OpenRouter requires apiKey or OPENROUTER_API_KEY');
    }
    const instance = new DecisionModel({ model, apiKey, endpoint: OPENROUTER_ENDPOINT });
    instance.#provider = 'openrouter';
    return instance;
  }

  get model(): string {
    return this.#model;
  }

  get provider(): string {
    return this.#provider;
  }

  protected async _evaluateImpl({
    input,
    decisions,
    abortSignal,
  }: {
    input: string;
    decisions: Readonly<Record<string, llm.Decision>>;
    connOptions: APIConnectOptions;
    abortSignal: AbortSignal;
  }): Promise<llm.DecisionResponse> {
    const questions = Object.fromEntries(
      Object.entries(decisions).map(([name, decision]) => [name, encodeQuestion(decision)]),
    );

    try {
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.#model, state: input, questions }),
        signal: abortSignal,
      });
      if (!response.ok) {
        throw new APIStatusError({
          message: 'TypeSafe decision request failed',
          options: {
            statusCode: response.status,
            requestId: response.headers.get('x-request-id'),
          },
        });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new APIError('invalid TypeSafe decision response', { retryable: false });
      }
      const parsed = parseResponse(body);
      const results: Record<string, llm.DecisionResult> = {};
      const errors: Record<string, string> = {};
      for (const [name, answer] of Object.entries(parsed.answers)) {
        try {
          results[name] = decodeAnswer(answer);
        } catch (error) {
          errors[name] = isAPIError(error) ? error.message : 'invalid Jev decision answer';
        }
      }
      return new llm.DecisionResponse({
        results,
        errors,
        model: parsed.model ?? '',
        provider: this.provider,
        requestId: parsed.id || response.headers.get('x-request-id') || '',
        inputTokens: parsed.usage?.input_tokens,
        outputTokens: parsed.usage?.output_tokens,
      });
    } catch (error) {
      if (abortSignal.aborted) throw abortSignal.reason;
      if (isAPIError(error)) throw error;
      throw new APIConnectionError({ message: 'TypeSafe connection failed' });
    }
  }
}

function encodeQuestion(decision: llm.Decision): Question {
  if (decision.kind === 'probability') {
    return { instructions: decision.prompt, type: 'noul' };
  }
  if (decision.kind === 'choice') {
    return { instructions: decision.prompt, type: 'choice', criteria: decision.options };
  }
  return { instructions: decision.prompt, type: 'score', criteria: decision.levels };
}

function parseResponse(value: unknown): JevResponse {
  if (!isRecord(value) || !isRecord(value.answers)) {
    throw new APIError('invalid TypeSafe decision response', { retryable: false });
  }
  if (value.model !== undefined && typeof value.model !== 'string') {
    throw new APIError('invalid TypeSafe decision response', { retryable: false });
  }
  if (value.id !== undefined && typeof value.id !== 'string') {
    throw new APIError('invalid TypeSafe decision response', { retryable: false });
  }
  const usage = value.usage;
  if (usage !== undefined) {
    if (
      !isRecord(usage) ||
      !isOptionalTokenCount(usage.input_tokens) ||
      !isOptionalTokenCount(usage.output_tokens)
    ) {
      throw new APIError('invalid TypeSafe decision response', { retryable: false });
    }
  }
  return value as unknown as JevResponse;
}

function decodeAnswer(value: unknown): llm.DecisionResult {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('invalid answer');
  if (value.type === 'noul') {
    if (typeof value.noul !== 'number') throw new Error('invalid answer');
    return new llm.ProbabilityResult({ value: value.noul });
  }
  if (value.type === 'choice') {
    if (
      typeof value.choice !== 'string' ||
      !isNumberRecord(value.probabilities) ||
      (value.confidence !== undefined &&
        value.confidence !== null &&
        typeof value.confidence !== 'number')
    ) {
      throw new Error('invalid answer');
    }
    return new llm.ChoiceResult({
      value: value.choice,
      probabilities: value.probabilities,
      providerData: { confidence: value.confidence ?? null },
    });
  }
  if (value.type === 'score') {
    if (
      typeof value.score !== 'number' ||
      !isNumberRecord(value.probabilities) ||
      !isStringRecord(value.legend) ||
      (value.confidence !== undefined &&
        value.confidence !== null &&
        typeof value.confidence !== 'number')
    ) {
      throw new Error('invalid answer');
    }
    const probabilities = value.probabilities;
    const legend = value.legend;
    const keys = Object.keys(legend);
    if (
      keys.length !== Object.keys(probabilities).length ||
      keys.some((key) => !Object.hasOwn(probabilities, key))
    ) {
      throw new APIError('score legend does not match distribution', { retryable: false });
    }
    if (keys.some((key) => !/^\d+$/.test(key))) throw new Error('invalid answer');
    return new llm.ScoreResult({
      value: value.score,
      probabilities,
      levels: keys.sort((a, b) => Number(a) - Number(b)).map((key) => legend[key]!),
      providerData: { confidence: value.confidence ?? null },
    });
  }
  throw new Error('invalid answer');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'number');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isOptionalTokenCount(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}
