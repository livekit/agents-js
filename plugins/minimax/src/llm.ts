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
}

/** Configuration options for the OpenAI-compatible MiniMax LLM. */
export interface LLMOptions
  extends MiniMaxLLMOptions,
    Pick<
      CompatibleOpenAILLMOptions,
      | 'client'
      | 'maxCompletionTokens'
      | 'parallelToolCalls'
      | 'strictToolSchema'
      | 'temperature'
      | 'toolChoice'
      | 'topP'
      | 'user'
    > {}

/** Configuration options for the Anthropic-compatible MiniMax LLM. */
export interface AnthropicLLMOptions
  extends MiniMaxLLMOptions,
    Pick<
      CompatibleAnthropicLLMOptions,
      'client' | 'maxTokens' | 'parallelToolCalls' | 'temperature' | 'toolChoice'
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
): ChatThinkingMode | undefined => {
  const modelInfo = CHAT_MODEL_INFO[model as ChatModels];
  const resolved =
    thinking ?? (modelInfo?.thinking.length === 1 ? modelInfo.thinking[0] : undefined);

  if (
    modelInfo &&
    resolved &&
    !(modelInfo.thinking as readonly ChatThinkingMode[]).includes(resolved)
  ) {
    throw new Error(`Thinking mode "${resolved}" is not supported by MiniMax model "${model}"`);
  }

  return resolved;
};

const withThinking = (
  extraKwargs: Record<string, unknown> | undefined,
  thinking: ChatThinkingMode | undefined,
): Record<string, unknown> => {
  const extras = { ...extraKwargs };
  if (thinking === 'adaptive' || thinking === 'disabled') {
    extras.thinking = { type: thinking };
  }
  return extras;
};

/** MiniMax LLM using the OpenAI-compatible API. */
export class LLM extends CompatibleOpenAILLM {
  readonly #baseURL: string;
  readonly #region: Region;
  readonly #thinking: ChatThinkingMode | undefined;

  constructor(opts: LLMOptions = {}) {
    const { region = DEFAULT_REGION, thinking, ...compatibleOpts } = opts;
    const endpoints = resolveRegion(region);
    const model = compatibleOpts.model ?? DEFAULT_CHAT_MODEL;
    const apiKey = compatibleOpts.apiKey ?? process.env.MINIMAX_API_KEY;
    const baseURL = compatibleOpts.baseURL ?? endpoints.openAIBaseURL;
    const resolvedThinking = resolveThinking(model, thinking);

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

  override chat(
    args: Parameters<CompatibleOpenAILLM['chat']>[0],
  ): ReturnType<CompatibleOpenAILLM['chat']> {
    return super.chat({
      ...args,
      extraKwargs: withThinking(args.extraKwargs, this.#thinking),
    });
  }
}

/** MiniMax LLM using the Anthropic-compatible API. */
export class AnthropicLLM extends CompatibleAnthropicLLM {
  readonly #baseURL: string;
  readonly #region: Region;
  readonly #thinking: ChatThinkingMode | undefined;

  constructor(opts: AnthropicLLMOptions = {}) {
    const { region = DEFAULT_REGION, thinking, ...compatibleOpts } = opts;
    const endpoints = resolveRegion(region);
    const model = compatibleOpts.model ?? DEFAULT_CHAT_MODEL;
    const apiKey = compatibleOpts.apiKey ?? process.env.MINIMAX_API_KEY;
    const baseURL = compatibleOpts.baseURL ?? endpoints.anthropicBaseURL;
    const resolvedThinking = resolveThinking(model, thinking);

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

  override chat(
    args: Parameters<CompatibleAnthropicLLM['chat']>[0],
  ): ReturnType<CompatibleAnthropicLLM['chat']> {
    return super.chat({
      ...args,
      extraKwargs: withThinking(args.extraKwargs, this.#thinking),
    });
  }
}
