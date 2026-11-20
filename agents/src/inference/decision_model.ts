// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIError, APIStatusError } from '../_exceptions.js';
import {
  DecisionModel as BaseDecisionModel,
  ChoiceResult,
  type Decision,
  DecisionResponse,
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

export interface DecisionModelOptions {
  model?: DecisionModels;
  /** Gateway models tried in order. An empty list disables the gateway default. */
  fallback?: DecisionModels | DecisionModels[];
  baseURL?: string;
  apiKey?: string;
  apiSecret?: string;
  fetch?: typeof globalThis.fetch;
}

type GatewayResponse = {
  id?: string;
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

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

function decodeAnswers(
  answers: Record<string, unknown>,
): [Record<string, ProbabilityResult | ChoiceResult | ScoreResult>, Record<string, string>] {
  const results: Record<string, ProbabilityResult | ChoiceResult | ScoreResult> = {};
  const errors: Record<string, string> = {};
  for (const [name, raw] of Object.entries(answers)) {
    try {
      const answer = object(raw);
      if (!answer) throw new Error('malformed answer');
      if (answer.type === 'refusal') {
        errors[name] = 'provider declined to answer';
      } else if (answer.type === 'noul' && typeof answer.noul === 'number') {
        results[name] = new ProbabilityResult({
          value: answer.noul,
          providerData: object(answer.provider_data) ?? {},
        });
      } else if (answer.type === 'choice' && typeof answer.choice === 'string') {
        const probabilities = object(answer.probabilities);
        results[name] = new ChoiceResult({
          value: answer.choice,
          probabilities: probabilities as Record<string, number> | undefined,
          providerData: {
            ...(object(answer.provider_data) ?? {}),
            ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
          },
        });
      } else if (answer.type === 'score' && typeof answer.score === 'number') {
        const probabilities = object(answer.probabilities);
        const legend = Array.isArray(answer.legend)
          ? answer.legend
          : Object.entries(object(answer.legend) ?? {})
              .sort(([left], [right]) => Number(left) - Number(right))
              .map(([, level]) => level);
        if (!probabilities || !legend.every((level) => typeof level === 'string')) {
          throw new Error('malformed score answer');
        }
        results[name] = new ScoreResult({
          value: answer.score,
          probabilities: Object.fromEntries(
            Object.entries(probabilities).map(([index, probability]) => [
              Number(index),
              probability,
            ]),
          ) as Record<number, number>,
          levels: legend as string[],
          providerData: {
            ...(object(answer.provider_data) ?? {}),
            ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
          },
        });
      } else {
        throw new Error('malformed answer');
      }
    } catch (error) {
      errors[name] = error instanceof Error ? error.message : 'malformed answer';
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
    } catch (error) {
      if (abortSignal.aborted) throw abortSignal.reason;
      throw new APIConnectionError({ message: 'inference gateway connection failed' });
    }

    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    if (!response.ok) {
      const text = await response.text();
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

    let parsed: GatewayResponse;
    try {
      parsed = (await response.json()) as GatewayResponse;
      if (!object(parsed) || !object(parsed.answers)) throw new Error('invalid response');
    } catch (error) {
      throw new APIError('invalid inference decision response', { retryable: false });
    }

    const fallbackModel = response.headers.get(DECISIONS_MODEL_FALLBACK_HEADER) ?? '';
    if (fallbackModel) {
      this.logger.warn(
        { model: this.configuredModel, fallbackModel },
        'inference decision was served by a fallback model',
      );
    }
    const [results, errors] = decodeAnswers(parsed.answers!);
    return new DecisionResponse({
      results,
      errors,
      model: parsed.model || fallbackModel,
      provider: this.provider,
      requestId: requestId ?? parsed.id,
      inputTokens: parsed.usage?.input_tokens,
      outputTokens: parsed.usage?.output_tokens,
    });
  }
}
