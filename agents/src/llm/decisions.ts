// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import { APIError, APITimeoutError, isAPIError } from '../_exceptions.js';
import type { DecisionMetrics } from '../metrics/base.js';
import { genAI, recordException, traceTypes, tracer } from '../telemetry/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, intervalForRetry } from '../types.js';
import { delay, waitUntilAborted, waitUntilTimeout } from '../utils.js';
import type { ChatContext } from './chat_context.js';

export type DecisionKind = 'probability' | 'choice' | 'score';

/** Estimate the probability that `prompt` is true. No boolean threshold is applied. */
export class Probability {
  readonly kind = 'probability' as const;

  constructor(readonly prompt: string) {}
}

/** Select one named option. Descriptions explain when each option applies. */
export class Choice {
  readonly kind = 'choice' as const;

  constructor(
    readonly prompt: string,
    readonly options: Record<string, string>,
  ) {}
}

/**
 * Estimate a position on ordered descriptive levels, numbered from zero.
 *
 * The result is the expected level index, including fractional positions.
 */
export class Score {
  readonly kind = 'score' as const;

  constructor(
    readonly prompt: string,
    readonly levels: string[],
  ) {}
}

export type Decision = Probability | Choice | Score;

export interface DecisionCapabilities {
  /** Decision kinds the model can evaluate */
  decisionKinds: DecisionKind[];
}

function validateProbability(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('probability must be finite and between 0 and 1');
  }
}

export class ProbabilityResult {
  readonly kind = 'probability' as const;
  value: number;
  providerData: Record<string, unknown>;

  constructor({
    value,
    providerData = {},
  }: {
    value: number;
    providerData?: Record<string, unknown>;
  }) {
    validateProbability(value);
    this.value = value;
    this.providerData = providerData;
  }
}

export class ChoiceResult {
  readonly kind = 'choice' as const;
  value: string;
  /** Provider distribution over option names, or undefined if unavailable. */
  probabilities?: Record<string, number>;
  providerData: Record<string, unknown>;

  constructor({
    value,
    probabilities,
    providerData = {},
  }: {
    value: string;
    probabilities?: Record<string, number> | null;
    providerData?: Record<string, unknown>;
  }) {
    Object.values(probabilities ?? {}).forEach(validateProbability);
    this.value = value;
    this.probabilities = probabilities ?? undefined;
    this.providerData = providerData;
  }
}

export class ScoreResult {
  readonly kind = 'score' as const;
  value: number;
  /** Provider distribution over zero-based level indices. */
  probabilities: Record<number, number>;
  levels: string[];
  providerData: Record<string, unknown>;

  constructor({
    value,
    probabilities,
    levels,
    providerData = {},
  }: {
    value: number;
    probabilities: Record<number, number>;
    levels: string[];
    providerData?: Record<string, unknown>;
  }) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('score must be finite and non-negative');
    }
    Object.values(probabilities).forEach(validateProbability);
    this.value = value;
    this.probabilities = probabilities;
    this.levels = levels;
    this.providerData = providerData;
  }
}

export type DecisionResult = ProbabilityResult | ChoiceResult | ScoreResult;

export class DecisionResponse {
  results: Record<string, DecisionResult>;
  /** Errors keyed by decision name. Failed decisions are absent from results. */
  errors: Record<string, string>;
  model: string;
  provider: string;
  requestId: string;
  inputTokens?: number;
  outputTokens?: number;

  constructor({
    results,
    errors = {},
    model = '',
    provider = '',
    requestId = '',
    inputTokens,
    outputTokens,
  }: {
    results: Record<string, DecisionResult>;
    errors?: Record<string, string>;
    model?: string;
    provider?: string;
    requestId?: string;
    inputTokens?: number;
    outputTokens?: number;
  }) {
    if (inputTokens !== undefined && (!Number.isInteger(inputTokens) || inputTokens < 0)) {
      throw new Error('inputTokens must be a non-negative integer');
    }
    if (outputTokens !== undefined && (!Number.isInteger(outputTokens) || outputTokens < 0)) {
      throw new Error('outputTokens must be a non-negative integer');
    }
    this.results = Object.fromEntries(Object.entries(results));
    this.errors = Object.fromEntries(Object.entries(errors));
    this.model = model;
    this.provider = provider;
    this.requestId = requestId;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
  }
}

/** @internal */
export function formatTranscript(
  chatCtx: ChatContext,
  { includeContextEvents = false }: { includeContextEvents?: boolean } = {},
): string {
  const lines: string[] = [];
  for (const item of chatCtx.items) {
    if (item.type === 'message') {
      if (!['user', 'assistant'].includes(item.role) || !item.textContent) continue;
      const interrupted = includeContextEvents && item.interrupted ? ' [interrupted]' : '';
      lines.push(`${item.role}: ${item.textContent}${interrupted}`);
    } else if (!includeContextEvents) {
      continue;
    } else if (item.type === 'function_call') {
      lines.push(`[function call: ${item.name}(${item.args})]`);
    } else if (item.type === 'function_call_output') {
      lines.push(`[function ${item.isError ? 'error' : 'output'}: ${item.output}]`);
    } else if (item.type === 'agent_handoff') {
      lines.push(`[agent handoff: ${item.oldAgentId} -> ${item.newAgentId}]`);
    }
  }
  return lines.join('\n');
}

function copyDecision(name: string, decision: Decision): Decision {
  let copied: Record<string, unknown>;
  if (decision.kind === 'choice') {
    copied = { options: { ...decision.options } };
  } else if (decision.kind === 'score') {
    copied = { levels: [...decision.levels] };
  } else if (decision.kind === 'probability') {
    copied = {};
  } else {
    throw new Error(
      `decision ${JSON.stringify(name)} has unknown kind ${JSON.stringify((decision as { kind?: unknown }).kind)}`,
    );
  }
  // keep the decision's class and fields, like Python's deepcopy
  return Object.assign(Object.create(Object.getPrototypeOf(decision)), decision, copied);
}

function copyDecisions(decisions: Readonly<Record<string, Decision>>): Record<string, Decision> {
  return Object.fromEntries(
    Object.entries(decisions).map(([name, decision]) => [name, copyDecision(name, decision)]),
  );
}

function validateDecisions(
  decisions: Readonly<Record<string, Decision>>,
  capabilities?: DecisionCapabilities,
): void {
  for (const [name, decision] of Object.entries(decisions)) {
    if (!name || !decision.prompt.trim()) {
      throw new Error('decisions require a name and non-empty prompt');
    }
    if (decision.kind === 'choice') {
      const names = Object.keys(decision.options);
      if (names.length < 2 || names.some((key) => !key)) {
        throw new Error(`decision ${JSON.stringify(name)} requires at least two named options`);
      }
    } else if (
      decision.kind === 'score' &&
      (decision.levels.length < 2 || decision.levels.some((level) => !level.trim()))
    ) {
      throw new Error(`decision ${JSON.stringify(name)} requires at least two described levels`);
    }
    if (capabilities && !capabilities.decisionKinds.includes(decision.kind)) {
      throw new Error(
        `decision model does not support ${JSON.stringify(decision.kind)} required by decision ${JSON.stringify(name)}`,
      );
    }
  }
}

function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, i) => key === rightKeys[i]);
}

function validateResultProbability(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new APIError('invalid probability', { retryable: false });
  }
}

function validateResult(result: DecisionResult, decision: Decision): void {
  if (result.kind !== decision.kind) {
    throw new APIError('wrong result kind', { retryable: false });
  }
  if (result.kind === 'probability') {
    validateResultProbability(result.value);
  } else if (result.kind === 'choice' && decision.kind === 'choice') {
    if (!Object.hasOwn(decision.options, result.value)) {
      throw new APIError('unknown choice', { retryable: false });
    }
    if (result.probabilities != null) {
      Object.values(result.probabilities).forEach(validateResultProbability);
      if (!sameKeys(result.probabilities, decision.options)) {
        throw new APIError('choice distribution does not match options', { retryable: false });
      }
      if (result.probabilities[result.value] !== Math.max(...Object.values(result.probabilities))) {
        throw new APIError('choice is not a most probable option', { retryable: false });
      }
    }
  } else if (result.kind === 'score' && decision.kind === 'score') {
    if (!Number.isFinite(result.value) || result.value < 0) {
      throw new APIError('invalid score', { retryable: false });
    }
    Object.values(result.probabilities).forEach(validateResultProbability);
    const expectedKeys = Object.fromEntries(decision.levels.map((_, index) => [index, true]));
    if (
      result.levels.length !== decision.levels.length ||
      result.levels.some((level, index) => level !== decision.levels[index]) ||
      !sameKeys(result.probabilities, expectedKeys)
    ) {
      throw new APIError('score distribution does not match levels', { retryable: false });
    }
    if (result.value > decision.levels.length - 1) {
      throw new APIError('score is outside the defined scale', { retryable: false });
    }
  }
}

function validateResponse(
  response: DecisionResponse,
  decisions: Readonly<Record<string, Decision>>,
): void {
  const names = new Set(Object.keys(decisions));
  if (
    [...Object.keys(response.results), ...Object.keys(response.errors)].some(
      (name) => !names.has(name),
    )
  ) {
    throw new APIError('decision response contains unknown decisions', { retryable: false });
  }
  if (Object.keys(response.results).some((name) => Object.hasOwn(response.errors, name))) {
    throw new APIError('decision response contains both a result and an error', {
      retryable: false,
    });
  }
  for (const [name, decision] of Object.entries(decisions)) {
    const result = Object.hasOwn(response.results, name) ? response.results[name] : undefined;
    if (result === undefined) {
      if (!Object.hasOwn(response.errors, name)) {
        Object.defineProperty(response.errors, name, {
          value: 'missing decision answer',
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      continue;
    }
    try {
      validateResult(result, decision);
    } catch (error) {
      if (!isAPIError(error)) throw error;
      delete response.results[name];
      Object.defineProperty(response.errors, name, {
        value: error.message,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
  }
}

class DecisionRequestTimeoutError extends Error {}

export type DecisionModelCallbacks = {
  ['metrics_collected']: (metrics: DecisionMetrics) => void;
};

/**
 * Provider-neutral batched decisions over a text input or conversation.
 *
 * A ChatContext is converted to a `role: text` transcript, so every provider receives
 * the same text. In `onUserTurnCompleted`, add the new message to the context first.
 */
export abstract class DecisionModel extends (EventEmitter as new () => TypedEmitter<DecisionModelCallbacks>) {
  readonly capabilities: DecisionCapabilities;
  readonly #label: string;

  constructor({ capabilities }: { capabilities: DecisionCapabilities }) {
    super();
    this.capabilities = capabilities;
    this.#label = `${this.constructor.name}`;
  }

  label(): string {
    return this.#label;
  }

  get model(): string {
    return 'unknown';
  }

  get provider(): string {
    return 'unknown';
  }

  /**
   * Evaluate a batch of decisions.
   *
   * Each requested name appears in either `results` or `errors`. Request failures
   * and malformed responses throw.
   *
   * @param input - Text to evaluate, sent as-is, or a conversation converted to a
   *   transcript of user and assistant text.
   * @param decisions - Decisions keyed by name. The provider receives copies that keep each
   *   decision's class and fields; JavaScript private (`#`) fields are not copied.
   * @param connOptions - Retry and per-attempt timeout settings.
   * @param abortSignal - Cancels the in-flight request and any pending retry.
   */
  async evaluate({
    input,
    decisions,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal,
  }: {
    input: string | ChatContext;
    decisions: Readonly<Record<string, Decision>>;
    connOptions?: APIConnectOptions;
    abortSignal?: AbortSignal;
  }): Promise<DecisionResponse> {
    return tracer.startActiveSpan(
      async (span) => {
        try {
          genAI.setRequestAttributes(span, {
            operation: undefined,
            model: this.model,
            provider: this.provider,
          });
          span.setAttribute('lk.decision_count', Object.keys(decisions).length);
          const definitions = copyDecisions(decisions);
          validateDecisions(definitions, this.capabilities);
          const text = typeof input === 'string' ? input : formatTranscript(input);
          if (Object.keys(definitions).length === 0) {
            return new DecisionResponse({
              results: {},
              model: this.model,
              provider: this.provider,
            });
          }

          const started = performance.now();
          let response: DecisionResponse | undefined;
          for (let attempt = 0; attempt <= connOptions.maxRetry; attempt++) {
            abortSignal?.throwIfAborted();
            const abortController = new AbortController();
            const signal = abortSignal
              ? AbortSignal.any([abortSignal, abortController.signal])
              : abortController.signal;
            let request: Promise<DecisionResponse> | undefined;
            try {
              request = this._evaluateImpl({
                input: text,
                decisions: definitions,
                connOptions,
                abortSignal: signal,
              });
              const outcome = await waitUntilTimeout(
                waitUntilAborted(request, signal),
                connOptions.timeoutMs,
                () => new DecisionRequestTimeoutError('decision request timed out'),
              );
              if (outcome.isAborted) throw abortSignal?.reason;
              response = outcome.result;
              break;
            } catch (error) {
              if (abortSignal?.aborted) throw abortSignal.reason;
              if (error instanceof DecisionRequestTimeoutError) {
                abortController.abort(error);
                // don't wait for providers that ignore the abort signal
                request?.catch(() => undefined);
              }
              const retryable =
                error instanceof DecisionRequestTimeoutError ||
                (isAPIError(error) && error.retryable);
              if (!retryable || attempt === connOptions.maxRetry) {
                if (error instanceof DecisionRequestTimeoutError) {
                  const timeout = new APITimeoutError({ message: 'decision request timed out' });
                  timeout.cause = error;
                  throw timeout;
                }
                throw error;
              }
              await delay(intervalForRetry(connOptions, attempt), { signal: abortSignal });
            }
          }
          if (!response) throw new Error('unreachable');

          response.model ||= this.model;
          response.provider ||= this.provider;
          genAI.setResponseAttributes(span, {
            responseId: response.requestId,
            model: response.model,
          });
          if (response.inputTokens !== undefined) {
            span.setAttribute(traceTypes.ATTR_GEN_AI_USAGE_INPUT_TOKENS, response.inputTokens);
          }
          if (response.outputTokens !== undefined) {
            span.setAttribute(traceTypes.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, response.outputTokens);
          }
          this.emit('metrics_collected', {
            type: 'decision_metrics',
            label: this.label(),
            requestId: response.requestId,
            timestamp: Date.now(),
            durationMs: Math.trunc(performance.now() - started),
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            metadata: { modelName: response.model, modelProvider: response.provider },
          });
          validateResponse(response, definitions);
          span.setAttribute('lk.decision_error_count', Object.keys(response.errors).length);
          return response;
        } catch (error) {
          recordException(span, error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      },
      { name: 'decision_model.evaluate' },
    );
  }

  protected abstract _evaluateImpl({
    input,
    decisions,
    connOptions,
    abortSignal,
  }: {
    input: string;
    decisions: Readonly<Record<string, Decision>>;
    connOptions: APIConnectOptions;
    abortSignal: AbortSignal;
  }): Promise<DecisionResponse>;

  /** Release resources owned by this model, if any. */
  async aclose(): Promise<void> {}
}
