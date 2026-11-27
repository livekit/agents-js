// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ApiError, type Decisions, GoogleGenAI } from '@google/genai';
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  llm,
} from '@livekit/agents';
import type { DecisionModels } from './models.js';

export interface DecisionModelOptions {
  /** Gemini decision model identifier. */
  model?: DecisionModels | (string & NonNullable<unknown>);
  /** Gemini API key. Defaults to `GOOGLE_API_KEY`. */
  apiKey?: string;
  /** Caller-owned client, used instead of `apiKey`, for example for Vertex AI. */
  client?: GoogleGenAI;
}

/** Gemini's Decisions API (`POST /v1beta/decisions`). */
export class DecisionModel extends llm.DecisionModel {
  readonly #model: string;
  readonly #client: GoogleGenAI;

  constructor({ model = 'gemini-decision-1', apiKey, client }: DecisionModelOptions = {}) {
    super({ capabilities: { decisionKinds: ['probability', 'choice', 'score'] } });
    this.#model = model;

    if (client) {
      this.#client = client;
      return;
    }

    const geminiApiKey = apiKey ?? process.env.GOOGLE_API_KEY;
    if (!geminiApiKey) {
      throw new Error(
        'Gemini API key is required, either as an argument or set GOOGLE_API_KEY environment variable',
      );
    }
    this.#client = new GoogleGenAI({
      apiKey: geminiApiKey,
      httpOptions: { retryOptions: { attempts: 1 } },
    });
  }

  override get model(): string {
    return this.#model;
  }

  override get provider(): string {
    return 'google';
  }

  protected override async _evaluateImpl({
    input,
    decisions,
    connOptions,
    abortSignal,
  }: {
    input: string;
    decisions: Readonly<Record<string, llm.Decision>>;
    connOptions: APIConnectOptions;
    abortSignal: AbortSignal;
  }): Promise<llm.DecisionResponse> {
    let decision: Decisions.CreateDecisionResponse;
    try {
      decision = await this.#client.decisions.create(
        {
          model: this.#model,
          input,
          questions: Object.fromEntries(
            Object.entries(decisions).map(([name, definition]) => [
              name,
              encodeQuestion(definition),
            ]),
          ),
          // The SDK defaults to v1, which has no decisions endpoint.
          api_version: 'v1beta',
        },
        {
          timeout_ms: connOptions.timeoutMs,
          signal: abortSignal,
          retries: { strategy: 'none' },
        },
      );
    } catch (error) {
      const status =
        error instanceof ApiError
          ? error.status
          : typeof error === 'object' &&
              error !== null &&
              typeof Reflect.get(error, 'status') === 'number'
            ? (Reflect.get(error, 'status') as number)
            : undefined;
      if (status !== undefined) {
        throw new APIStatusError({
          message: error instanceof Error ? error.message : 'Gemini decision request failed',
          options: { statusCode: status },
        });
      }
      if (error instanceof APIError) throw error;
      throw new APIConnectionError({
        message: 'Gemini decision request failed',
        options: { retryable: true },
      });
    }

    const feedback = decision.prompt_feedback;
    if (feedback?.block_reason) {
      throw new APIError(
        `Gemini blocked the decision input: ${feedback.block_reason_message ?? feedback.block_reason}`,
        { retryable: false },
      );
    }

    const results: Record<string, llm.DecisionResult> = {};
    const errors: Record<string, string> = {};
    for (const [name, answer] of Object.entries(decision.answers ?? {})) {
      const definition = decisions[name];
      if (!definition) {
        throw new APIError('decision response contains unknown decisions', { retryable: false });
      }
      try {
        results[name] = decodeAnswer(answer, definition);
      } catch (error) {
        errors[name] = error instanceof APIError ? error.message : 'invalid Gemini decision answer';
      }
    }

    return new llm.DecisionResponse({
      results,
      errors,
      model: this.#model,
      provider: this.provider,
      requestId: '',
      inputTokens: decision.usage?.total_input_tokens,
      outputTokens: decision.usage?.total_output_tokens,
    });
  }
}

function encodeQuestion(definition: llm.Decision): Decisions.Question {
  if (definition.kind === 'probability') {
    return { type: 'noul', instructions: definition.prompt };
  }
  if (definition.kind === 'choice') {
    return {
      type: 'choice',
      instructions: definition.prompt,
      criteria: { ...definition.options },
    };
  }
  return { type: 'score', instructions: definition.prompt, criteria: definition.levels };
}

function decodeAnswer(answer: Decisions.Answer, definition: llm.Decision): llm.DecisionResult {
  if (!answer || typeof answer !== 'object') throw new Error('invalid answer');
  if (answer.type === 'noul') {
    requireNumber(answer.confidence);
    return new llm.ProbabilityResult({
      value: requireNumber(answer.noul),
      providerData: { confidence: answer.confidence },
    });
  }
  if (answer.type === 'choice') {
    requireNumber(answer.confidence);
    if (typeof answer.choice !== 'string') throw new Error('invalid choice');
    requireProbabilities(answer.probabilities);
    return new llm.ChoiceResult({
      value: answer.choice,
      probabilities: answer.probabilities,
      providerData: { confidence: answer.confidence },
    });
  }
  if (answer.type === 'score') {
    requireNumber(answer.confidence);
    requireNumber(answer.score);
    requireProbabilities(answer.probabilities);
    if (!answer.legend || typeof answer.legend !== 'object') throw new Error('invalid legend');

    const probabilities: Record<number, number> = {};
    for (const [level, probability] of Object.entries(answer.probabilities)) {
      // Number() would also take "00" or " 1", merging two keys into one level.
      if (!/^(0|[1-9]\d*)$/.test(level)) {
        throw new APIError('score distribution is not keyed by level', { retryable: false });
      }
      probabilities[Number(level)] = probability;
    }
    return new llm.ScoreResult({
      value: answer.score,
      probabilities,
      levels: definition.kind === 'score' ? definition.levels : [],
      providerData: { confidence: answer.confidence },
    });
  }
  throw new APIError('unsupported Gemini decision answer', { retryable: false });
}

function requireNumber(value: unknown): number {
  if (typeof value !== 'number') throw new Error('invalid number');
  return value;
}

function requireProbabilities(value: unknown): asserts value is Record<string, number> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((probability) => typeof probability !== 'number')
  ) {
    throw new Error('invalid probabilities');
  }
}
