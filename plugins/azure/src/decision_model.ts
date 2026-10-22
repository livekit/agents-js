// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  DecisionModel as BaseDecisionModel,
  type Decision,
  DecisionResponse,
} from '@livekit/agents';
import * as systemone from '@livekit/agents/llm/systemone';

/** @public */
export type DecisionModels = 'Microsoft-Decision-1';

/** @public */
export interface DecisionModelOptions {
  /** Full Microsoft Foundry System One POST endpoint. Defaults to `MICROSOFT_AI_DECISION_URL`. */
  url?: string;
  /** Foundry deployment name. Defaults to `MICROSOFT_AI_DECISION_MODEL`. */
  model?: DecisionModels | string;
  /** Foundry resource key or Entra ID token. Defaults to `MICROSOFT_AI_DECISION_API_KEY`. */
  apiKey?: string;
  /** Authentication header. Defaults to `MICROSOFT_AI_DECISION_AUTH_HEADER` or `api-key`. */
  authHeader?: 'Authorization' | 'api-key';
  /** Explicit headers to use instead of `apiKey` and `authHeader`. */
  headers?: Record<string, string>;
  /** Caller-owned fetch implementation. Defaults to the built-in fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Microsoft-Decision-1 through a Microsoft Foundry System One endpoint. @public */
export class DecisionModel extends BaseDecisionModel {
  readonly #url: string;
  readonly #model: string;
  readonly #headers: Record<string, string>;
  readonly #fetch?: typeof globalThis.fetch;

  constructor(options: DecisionModelOptions = {}) {
    super({ capabilities: { decisionKinds: ['probability', 'choice', 'score'] } });

    this.#model = required(options.model, 'MICROSOFT_AI_DECISION_MODEL');
    this.#url = validateEndpoint(required(options.url, 'MICROSOFT_AI_DECISION_URL'));
    this.#headers = authenticationHeaders(options);
    this.#fetch = options.fetch;
  }

  get model(): string {
    return this.#model;
  }

  get provider(): string {
    return 'Microsoft AI';
  }

  protected async _evaluateImpl({
    input,
    decisions,
    connOptions: _connOptions,
    abortSignal,
  }: {
    input: string;
    decisions: Readonly<Record<string, Decision>>;
    connOptions: APIConnectOptions;
    abortSignal: AbortSignal;
  }): Promise<DecisionResponse> {
    const questions = Object.fromEntries(
      Object.entries(decisions).map(([name, decision]) => [
        name,
        systemone.encodeQuestion(decision),
      ]),
    );

    try {
      const response = await (this.#fetch ?? globalThis.fetch)(this.#url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.#headers },
        body: JSON.stringify({ model: this.#model, state: input, questions }),
        redirect: 'manual',
        signal: abortSignal,
      });
      let requestId =
        response.headers.get('x-request-id') ?? response.headers.get('apim-request-id');

      if (response.status !== 200) {
        throw new APIStatusError({
          message: 'Microsoft AI decision request failed',
          options: {
            statusCode: response.status,
            requestId,
            body: await response.text(),
            retryable:
              response.status === 408 ||
              response.status === 429 ||
              (response.status >= 500 && response.status < 600),
          },
        });
      }

      const parsed = systemone.responseSchema.parse(await response.json());
      requestId = parsed.id || requestId;
      const { results, errors } = systemone.decodeAnswers(parsed.answers, {
        invalid: 'invalid Microsoft AI decision answer',
      });
      return new DecisionResponse({
        results,
        errors,
        model: parsed.model,
        provider: this.provider,
        requestId: requestId ?? '',
        inputTokens: parsed.usage.input_tokens ?? undefined,
        outputTokens: parsed.usage.output_tokens ?? undefined,
      });
    } catch (error) {
      if (error instanceof APIError) throw error;
      if (isAbortError(error) || abortSignal.aborted) {
        throw new APITimeoutError({ message: 'Microsoft AI decision request timed out' });
      }
      if (error instanceof SyntaxError) {
        throw new APIError('invalid Microsoft AI decision response', { retryable: false });
      }
      if (error instanceof TypeError) {
        throw new APIConnectionError({ message: 'Microsoft AI decision transport failed' });
      }
      throw new APIError('invalid Microsoft AI decision response', { retryable: false });
    }
  }

  async aclose(): Promise<void> {}
}

function required(value: string | undefined, environmentName: string): string {
  const resolved = value ?? process.env[environmentName];
  if (resolved === undefined || !resolved.trim()) {
    throw new Error(`Set ${environmentName} or pass its constructor option`);
  }
  return resolved;
}

function validateEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('MICROSOFT_AI_DECISION_URL must be a full https endpoint URL');
  }

  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error('MICROSOFT_AI_DECISION_URL must be a full https endpoint URL');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('Microsoft AI DECISION requires TLS except on loopback endpoints');
  }
  return endpoint;
}

function authenticationHeaders(options: DecisionModelOptions): Record<string, string> {
  if (options.headers !== undefined) {
    if (options.apiKey !== undefined) throw new Error('Pass either apiKey or headers, not both');
    if (options.authHeader !== undefined) {
      throw new Error('Pass either authHeader or headers, not both');
    }
    return { ...options.headers, 'User-Agent': options.headers['User-Agent'] ?? 'LiveKit Agents' };
  }

  const authHeader =
    options.authHeader ?? environment('MICROSOFT_AI_DECISION_AUTH_HEADER') ?? 'api-key';
  if (authHeader !== 'Authorization' && authHeader !== 'api-key') {
    throw new Error(
      'MICROSOFT_AI_DECISION_AUTH_HEADER/authHeader must be Authorization or api-key',
    );
  }
  const apiKey = required(options.apiKey, 'MICROSOFT_AI_DECISION_API_KEY');
  if ([...apiKey].some((character) => character.charCodeAt(0) < 32 || character === '\x7f')) {
    throw new Error('MICROSOFT_AI_DECISION_API_KEY cannot contain control characters');
  }
  return {
    [authHeader]: authHeader === 'Authorization' ? `Bearer ${apiKey}` : apiKey,
    'User-Agent': 'LiveKit Agents',
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name);
}

function environment(name: string): string | undefined {
  return process.env[name];
}
