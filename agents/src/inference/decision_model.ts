// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { APIConnectionError, APIError, APIStatusError } from '../_exceptions.js';
import {
  DecisionModel as BaseDecisionModel,
  ChoiceResult,
  type Decision,
  DecisionResponse,
  type DecisionResult,
  ProbabilityResult,
  ScoreResult,
} from '../llm/decisions.js';
import { log } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import {
  type AnyString,
  buildMetadataHeaders,
  createAccessToken,
  getDefaultInferenceUrl,
  resolveCredentials,
} from './utils.js';

const REQUEST_ID_HEADER = 'X-LiveKit-Request-Id';
const DECISIONS_MODEL_FALLBACK_HEADER = 'X-LiveKit-Inference-Decisions-Model-Fallback';

export type DecisionModels =
  | 'openai/gpt-6-luna-decisions'
  | 'google/gemini-decision-1'
  | 'microsoft/decision-1'
  | 'microsoft-eu/decision-1'
  | AnyString;

/** Options for sending decision requests to the LiveKit Inference gateway. */
export interface DecisionModelOptions {
  model?: DecisionModels;
  /** Gateway models tried in order. An empty list disables the gateway default. */
  fallback?: DecisionModels | DecisionModels[];
  baseURL?: string;
  apiKey?: string;
  apiSecret?: string;
  fetch?: typeof globalThis.fetch;
}

const wireObject = z.custom<Record<string, unknown>>((value) => object(value) !== undefined);
const wireUsageCount = z.number().int().nonnegative().nullish();
const gatewayResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  answers: wireObject,
  usage: z.object({ input_tokens: wireUsageCount, output_tokens: wireUsageCount }).optional(),
});

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number() }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: wireObject,
    confidence: z.number().nullish(),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: wireObject,
    legend: z.union([z.array(z.string()), wireObject]),
    confidence: z.number().nullish(),
  }),
  z.object({ type: z.literal('refusal') }),
]);

function encodeDecision(decision: Decision): Record<string, unknown> {
  if (decision.kind === 'probability') {
    return { type: 'noul', instructions: decision.prompt };
  }
  if (decision.kind === 'choice') {
    return { type: 'choice', instructions: decision.prompt, criteria: { ...decision.options } };
  }
  return { type: 'score', instructions: decision.prompt, criteria: [...decision.levels] };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseGatewayResponse(text: string) {
  try {
    return gatewayResponseSchema.parse(JSON.parse(text));
  } catch (cause) {
    const error = new APIError('invalid inference decision response', { retryable: false });
    error.cause = cause;
    throw error;
  }
}

function byLevelIndex(values: Record<string, unknown> | string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const decimal = key.trim();
      if (!/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(decimal)) {
        throw new Error('invalid level index');
      }
      const index = Number(decimal.replaceAll('_', ''));
      if (!Number.isSafeInteger(index)) {
        throw new Error('invalid level index');
      }
      return [index, value];
    }),
  );
}

function decodeAnswer(raw: unknown): DecisionResult {
  const answer = answerSchema.parse(raw);
  if (answer.type === 'refusal') {
    throw new APIError('the model declined this decision', { retryable: false });
  }
  if (answer.type === 'noul') {
    return new ProbabilityResult({ value: answer.noul });
  }
  const providerData = { confidence: answer.confidence ?? null };
  if (answer.type === 'choice') {
    return new ChoiceResult({
      value: answer.choice,
      probabilities: answer.probabilities as Record<string, number>,
      providerData,
    });
  }

  const probabilities = byLevelIndex(answer.probabilities);
  const legend = byLevelIndex(answer.legend);
  const indices = Object.keys(probabilities);
  if (
    indices.length !== Object.keys(legend).length ||
    indices.some((key) => !Object.hasOwn(legend, key))
  ) {
    throw new APIError('score legend does not match distribution', { retryable: false });
  }
  const levels = indices
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => legend[key]);
  if (!levels.every((level) => typeof level === 'string')) {
    throw new Error('invalid score legend');
  }
  return new ScoreResult({
    value: answer.score,
    probabilities: probabilities as Record<number, number>,
    levels,
    providerData,
  });
}

function decodeAnswers(
  answers: Record<string, unknown>,
): [Record<string, DecisionResult>, Record<string, string>] {
  const results: Record<string, DecisionResult> = Object.create(null);
  const errors: Record<string, string> = Object.create(null);
  for (const [name, raw] of Object.entries(answers)) {
    try {
      results[name] = decodeAnswer(raw);
    } catch (error) {
      errors[name] = error instanceof APIError ? error.message : 'invalid decision answer';
    }
  }
  return [results, errors];
}

/** Decision models served through LiveKit Inference (`POST /v1/decisions`). */
export class DecisionModel extends BaseDecisionModel {
  private readonly configuredModel: DecisionModels;
  private readonly fallback?: DecisionModels[];
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly logger = log();

  constructor({
    model = 'openai/gpt-6-luna-decisions',
    fallback,
    baseURL = getDefaultInferenceUrl(),
    apiKey,
    apiSecret,
    fetch = globalThis.fetch,
  }: DecisionModelOptions = {}) {
    super({ capabilities: { decisionKinds: ['probability', 'choice', 'score'] } });
    const credentials = resolveCredentials(apiKey, apiSecret);
    this.configuredModel = model;
    this.fallback =
      fallback === undefined ? undefined : Array.isArray(fallback) ? [...fallback] : [fallback];
    this.baseURL = baseURL;
    this.apiKey = credentials.apiKey;
    this.apiSecret = credentials.apiSecret;
    this.fetch = fetch;
  }

  override get model(): string {
    return this.configuredModel;
  }

  override get provider(): string {
    return 'livekit';
  }

  protected override async _evaluateImpl({
    input,
    decisions,
    abortSignal,
  }: {
    input: string;
    decisions: Readonly<Record<string, Decision>>;
    connOptions: APIConnectOptions;
    abortSignal: AbortSignal;
  }): Promise<DecisionResponse> {
    const body: Record<string, unknown> = {
      model: this.configuredModel,
      state: input,
      questions: Object.fromEntries(
        Object.entries(decisions).map(([name, decision]) => [name, encodeDecision(decision)]),
      ),
    };
    if (this.fallback !== undefined) {
      body.fallback = { models: this.fallback.map((model) => ({ model })) };
    }

    let response: Response;
    let text: string;
    try {
      response = await this.fetch(`${this.baseURL.replace(/\/$/, '')}/decisions`, {
        method: 'POST',
        headers: {
          ...buildMetadataHeaders(),
          Authorization: `Bearer ${await createAccessToken(this.apiKey, this.apiSecret)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
      text = await response.text();
    } catch (cause) {
      abortSignal.throwIfAborted();
      const error = new APIConnectionError({ message: 'inference gateway connection failed' });
      error.cause = cause;
      throw error;
    }

    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    if (!response.ok) {
      let parsed: unknown = text;
      let detail = '';
      try {
        parsed = JSON.parse(text) as unknown;
        const errorBody = object(parsed);
        detail =
          (typeof errorBody?.error === 'string' && errorBody.error) ||
          (typeof errorBody?.type === 'string' && errorBody.type) ||
          '';
      } catch {
        // Keep the raw response body.
      }
      throw new APIStatusError({
        message: `inference gateway returned an error${detail ? `: ${detail}` : ''}`,
        options: { statusCode: response.status, requestId, body: parsed as string | object },
      });
    }

    const parsed = parseGatewayResponse(text);
    const fallbackModel = response.headers.get(DECISIONS_MODEL_FALLBACK_HEADER) ?? '';
    if (fallbackModel) {
      this.logger.warn(
        { model: this.configuredModel, fallbackModel },
        'inference decision was served by a fallback model',
      );
    }
    const [results, errors] = decodeAnswers(parsed.answers);
    return new DecisionResponse({
      results,
      errors,
      model: parsed.model || fallbackModel,
      provider: this.provider,
      requestId: requestId || parsed.id,
      inputTokens: parsed.usage?.input_tokens ?? undefined,
      outputTokens: parsed.usage?.output_tokens ?? undefined,
    });
  }
}
