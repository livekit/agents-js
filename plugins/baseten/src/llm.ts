// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Baseten LLM plugin for LiveKit Agents
 * Configures the OpenAI plugin to work with Baseten's OpenAI-compatible API
 */
import type { APIConnectOptions } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, inference, llm } from '@livekit/agents';
import { OpenAI } from 'openai';
import type { BasetenLLMOptions } from './types.js';

export interface LLMOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  user?: string;
  temperature?: number;
  client?: OpenAI;
  toolChoice?: llm.ToolChoice;
  parallelToolCalls?: boolean;
  metadata?: Record<string, string>;
  maxCompletionTokens?: number;
  serviceTier?: string;
  store?: boolean;
  strictToolSchema?: boolean;
}

const defaultLLMOptions: LLMOptions = {
  model: 'openai/gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
  parallelToolCalls: true,
  strictToolSchema: false,
};

export class OpenAILLM extends llm.LLM {
  #opts: LLMOptions;
  #client: OpenAI;
  #providerFmt: llm.ProviderFormat;

  constructor(
    opts: Partial<LLMOptions> = defaultLLMOptions,
    providerFmt: llm.ProviderFormat = 'openai',
  ) {
    super();

    this.#opts = { ...defaultLLMOptions, ...opts };
    this.#providerFmt = providerFmt;
    if (this.#opts.apiKey === undefined) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    this.#client =
      this.#opts.client ||
      new OpenAI({
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
      });
  }

  label(): string {
    return 'openai.LLM';
  }

  get model(): string {
    return this.#opts.model;
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    parallelToolCalls,
    toolChoice,
    extraKwargs,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): inference.LLMStream {
    const extras: Record<string, unknown> = { ...extraKwargs };

    if (this.#opts.metadata) {
      extras.metadata = this.#opts.metadata;
    }

    if (this.#opts.user) {
      extras.user = this.#opts.user;
    }

    if (this.#opts.maxCompletionTokens) {
      extras.max_completion_tokens = this.#opts.maxCompletionTokens;
    }

    if (this.#opts.temperature) {
      extras.temperature = this.#opts.temperature;
    }

    if (this.#opts.serviceTier) {
      extras.service_tier = this.#opts.serviceTier;
    }

    if (this.#opts.store !== undefined) {
      extras.store = this.#opts.store;
    }

    parallelToolCalls =
      parallelToolCalls !== undefined ? parallelToolCalls : this.#opts.parallelToolCalls;
    if (toolCtx && Object.keys(toolCtx).length > 0 && parallelToolCalls !== undefined) {
      extras.parallel_tool_calls = parallelToolCalls;
    }

    toolChoice = toolChoice !== undefined ? toolChoice : this.#opts.toolChoice;
    if (toolChoice) {
      extras.tool_choice = toolChoice;
    }

    return new LLMStream(this as unknown as inference.LLM, {
      model: this.#opts.model,
      providerFmt: this.#providerFmt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: this.#client as any,
      chatCtx,
      toolCtx,
      connOptions,
      modelOptions: extras,
      strictToolSchema: this.#opts.strictToolSchema || false,
      gatewayOptions: undefined, // OpenAI plugin doesn't use gateway authentication
    });
  }
}

export class LLMStream extends inference.LLMStream {}

export class LLM extends OpenAILLM {
  constructor(opts: BasetenLLMOptions) {
    const apiKey = opts.apiKey ?? process.env.BASETEN_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Baseten API key is required. Set BASETEN_API_KEY environment variable or pass apiKey in options.',
      );
    }

    if (!opts.model) {
      throw new Error(
        'Model is required. Please specify a model name (e.g., "openai/gpt-4o-mini").',
      );
    }

    const model = opts.model;

    // Configure the OpenAI plugin with Baseten's endpoint
    super({
      model,
      apiKey,
      baseURL: 'https://inference.baseten.co/v1',
      temperature: opts.temperature,
      user: opts.user,
      maxCompletionTokens: opts.maxTokens,
      toolChoice: opts.toolChoice,
      parallelToolCalls: opts.parallelToolCalls,
    });
  }

  label(): string {
    return 'baseten.LLM';
  }
}
