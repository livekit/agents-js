// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  LLM as CompatibleAnthropicLLM,
  type LLMOptions as CompatibleAnthropicLLMOptions,
} from '@livekit/agents-plugin-anthropic';
import {
  LLM as CompatibleOpenAILLM,
  type LLMOptions as CompatibleOpenAILLMOptions,
} from '@livekit/agents-plugin-openai';
import {
  CHAT_MODEL_INFO,
  type ChatModels,
  type ChatReasoningEffort,
  type ChatThinkingMode,
  DEFAULT_CHAT_MODEL,
  DEFAULT_REGION,
  REGIONAL_ENDPOINTS,
  type Region,
} from './models.js';

/** Shared configuration options for MiniMax LLM compatibility APIs. */
export interface MiniMaxLLMOptions {
  /** MiniMax model identifier. Defaults to {@link DEFAULT_CHAT_MODEL}. */
  model?: string | ChatModels;
  /** API key. Falls back to `$MINIMAX_API_KEY`. */
  apiKey?: string;
  /** API region. Defaults to {@link DEFAULT_REGION}. */
  region?: Region;
  /** Custom compatible API base URL. Overrides the selected region. */
  baseURL?: string;
  /** Model thinking behavior. */
  thinking?: ChatThinkingMode;
  /** Reasoning effort for models that support it. */
  reasoningEffort?: ChatReasoningEffort;
}

/** Configuration options for the OpenAI-compatible MiniMax LLM. */
export interface LLMOptions
  extends MiniMaxLLMOptions,
    Partial<
      Pick<
        CompatibleOpenAILLMOptions,
        | 'client'
        | 'maxCompletionTokens'
        | 'parallelToolCalls'
        | 'serviceTier'
        | 'strictToolSchema'
        | 'temperature'
        | 'toolChoice'
        | 'topP'
        | 'user'
      >
    > {}

/** Configuration options for the Anthropic-compatible MiniMax LLM. */
export interface AnthropicLLMOptions
  extends MiniMaxLLMOptions,
    Partial<
      Pick<
        CompatibleAnthropicLLMOptions,
        'client' | 'maxTokens' | 'parallelToolCalls' | 'temperature' | 'toolChoice'
      >
    > {}

const resolveRegion = (region: Region): (typeof REGIONAL_ENDPOINTS)[Region] => {
  const endpoints = REGIONAL_ENDPOINTS[region];
  if (!endpoints) {
    throw new Error(`Unsupported MiniMax region: ${region}`);
  }
  return endpoints;
};

const resolveThinking = (
  model: string,
  thinking: ChatThinkingMode | undefined,
  api: 'openAI' | 'anthropic',
): ChatThinkingMode | undefined => {
  const modelInfo = CHAT_MODEL_INFO[model as ChatModels];
  const resolved = thinking ?? modelInfo?.thinkingDefaults[api];

  if (
    modelInfo &&
    resolved &&
    !(modelInfo.thinking as readonly ChatThinkingMode[]).includes(resolved)
  ) {
    throw new Error(`Thinking mode "${resolved}" is not supported by MiniMax model "${model}"`);
  }

  return resolved;
};

const resolveReasoningEffort = (
  model: string,
  reasoningEffort: ChatReasoningEffort | undefined,
): ChatReasoningEffort | undefined => {
  const modelInfo = CHAT_MODEL_INFO[model as ChatModels];
  if (!modelInfo) return reasoningEffort;
  if (modelInfo.reasoningEfforts.length === 0) return undefined;

  const resolved = reasoningEffort ?? modelInfo.reasoningEffortDefault ?? undefined;
  if (
    resolved &&
    !(modelInfo.reasoningEfforts as readonly ChatReasoningEffort[]).includes(resolved)
  ) {
    throw new Error(`Reasoning effort "${resolved}" is not supported by MiniMax model "${model}"`);
  }
  return resolved;
};

const withRequestOptions = (
  extraKwargs: Record<string, unknown> | undefined,
  thinking: ChatThinkingMode | undefined,
  reasoningEffort: ChatReasoningEffort | undefined,
  api: 'openAI' | 'anthropic',
): Record<string, unknown> => {
  const extras = { ...extraKwargs };
  if (thinking === 'adaptive' || thinking === 'disabled') {
    extras.thinking = { type: thinking };
  }
  if (reasoningEffort) {
    if (api === 'openAI') {
      extras.reasoning_effort = reasoningEffort;
    } else {
      const outputConfig =
        typeof extras.output_config === 'object' && extras.output_config !== null
          ? extras.output_config
          : {};
      extras.output_config = { ...outputConfig, effort: reasoningEffort };
    }
  }
  return extras;
};

/** MiniMax LLM using the OpenAI-compatible API. */
export class LLM extends CompatibleOpenAILLM {
  readonly #baseURL: string;
  readonly #region: Region;
  readonly #thinking: ChatThinkingMode | undefined;
  readonly #reasoningEffort: ChatReasoningEffort | undefined;

  constructor(opts: LLMOptions = {}) {
    const { region = DEFAULT_REGION, thinking, reasoningEffort, ...compatibleOpts } = opts;
    const endpoints = resolveRegion(region);
    const model = compatibleOpts.model ?? DEFAULT_CHAT_MODEL;
    const apiKey = compatibleOpts.apiKey ?? process.env.MINIMAX_API_KEY;
    const baseURL = compatibleOpts.baseURL ?? endpoints.openAIBaseURL;
    const resolvedThinking = resolveThinking(model, thinking, 'openAI');
    const resolvedReasoningEffort = resolveReasoningEffort(model, reasoningEffort);

    if (!apiKey && !compatibleOpts.client) {
      throw new Error('MiniMax API key is required, either as an argument or as $MINIMAX_API_KEY');
    }

    super({
      ...compatibleOpts,
      apiKey,
      baseURL,
      model,
      strictToolSchema: compatibleOpts.strictToolSchema ?? false,
    });

    this.#baseURL = baseURL;
    this.#region = region;
    this.#thinking = resolvedThinking;
    this.#reasoningEffort = resolvedReasoningEffort;
  }

  override label(): string {
    return 'minimax.LLM';
  }

  override get provider(): string {
    return 'MiniMax';
  }

  /** Resolved compatible API base URL. */
  get baseURL(): string {
    return this.#baseURL;
  }

  /** Resolved MiniMax API region. */
  get region(): Region {
    return this.#region;
  }

  /** Resolved model thinking behavior. */
  get thinking(): ChatThinkingMode | undefined {
    return this.#thinking;
  }

  /** Resolved model reasoning effort. */
  get reasoningEffort(): ChatReasoningEffort | undefined {
    return this.#reasoningEffort;
  }

  override chat(
    args: Parameters<CompatibleOpenAILLM['chat']>[0],
  ): ReturnType<CompatibleOpenAILLM['chat']> {
    return super.chat({
      ...args,
      extraKwargs: withRequestOptions(
        args.extraKwargs,
        this.#thinking,
        this.#reasoningEffort,
        'openAI',
      ),
    });
  }
}

/** MiniMax LLM using the Anthropic-compatible API. */
export class AnthropicLLM extends CompatibleAnthropicLLM {
  readonly #baseURL: string;
  readonly #region: Region;
  readonly #thinking: ChatThinkingMode | undefined;
  readonly #reasoningEffort: ChatReasoningEffort | undefined;

  constructor(opts: AnthropicLLMOptions = {}) {
    const { region = DEFAULT_REGION, thinking, reasoningEffort, ...compatibleOpts } = opts;
    const endpoints = resolveRegion(region);
    const model = compatibleOpts.model ?? DEFAULT_CHAT_MODEL;
    const apiKey = compatibleOpts.apiKey ?? process.env.MINIMAX_API_KEY;
    const baseURL = compatibleOpts.baseURL ?? endpoints.anthropicBaseURL;
    const resolvedThinking = resolveThinking(model, thinking, 'anthropic');
    const resolvedReasoningEffort = resolveReasoningEffort(model, reasoningEffort);

    if (!apiKey && !compatibleOpts.client) {
      throw new Error('MiniMax API key is required, either as an argument or as $MINIMAX_API_KEY');
    }

    super({
      ...compatibleOpts,
      apiKey,
      baseURL,
      model,
    });

    this.#baseURL = baseURL;
    this.#region = region;
    this.#thinking = resolvedThinking;
    this.#reasoningEffort = resolvedReasoningEffort;
  }

  override label(): string {
    return 'minimax.AnthropicLLM';
  }

  override get provider(): string {
    return 'MiniMax';
  }

  /** Resolved compatible API base URL. */
  get baseURL(): string {
    return this.#baseURL;
  }

  /** Resolved MiniMax API region. */
  get region(): Region {
    return this.#region;
  }

  /** Resolved model thinking behavior. */
  get thinking(): ChatThinkingMode | undefined {
    return this.#thinking;
  }

  /** Resolved model reasoning effort. */
  get reasoningEffort(): ChatReasoningEffort | undefined {
    return this.#reasoningEffort;
  }

  override chat(
    args: Parameters<CompatibleAnthropicLLM['chat']>[0],
  ): ReturnType<CompatibleAnthropicLLM['chat']> {
    return super.chat({
      ...args,
      extraKwargs: withRequestOptions(
        args.extraKwargs,
        this.#thinking,
        this.#reasoningEffort,
        'anthropic',
      ),
    });
  }
}
