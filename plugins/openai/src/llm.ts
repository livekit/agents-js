// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, inference, llm } from '@livekit/agents';
import { AzureOpenAI, OpenAI } from 'openai';
import type {
  CerebrasChatModels,
  ChatModels,
  DeepSeekChatModels,
  GroqChatModels,
  MetaChatModels,
  OctoChatModels,
  PerplexityChatModels,
  TelnyxChatModels,
  TogetherChatModels,
  XAIChatModels,
} from './models.js';

export interface LLMOptions {
  model: string | ChatModels;
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
  model: 'gpt-4.1',
  apiKey: process.env.OPENAI_API_KEY,
  parallelToolCalls: true,
  strictToolSchema: false,
};

const defaultAzureLLMOptions: LLMOptions = {
  model: 'gpt-4.1',
  apiKey: process.env.AZURE_API_KEY,
  strictToolSchema: false,
};

export class LLM extends llm.LLM {
  #opts: LLMOptions;
  #client: OpenAI;
  #providerFmt: llm.ProviderFormat;

  /**
   * Create a new instance of OpenAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your OpenAI API key, either using the argument or by setting the
   * `OPENAI_API_KEY` environment variable.
   */
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
        baseURL: this.#opts.baseURL,
        apiKey: this.#opts.apiKey,
      });
  }

  label(): string {
    return 'openai.LLM';
  }

  get model(): string {
    return this.#opts.model;
  }

  /**
   * Create a new instance of OpenAI LLM with Azure.
   *
   * @remarks
   * This automatically infers the following arguments from their corresponding environment variables if they are not provided:
   * - `apiKey` from `AZURE_OPENAI_API_KEY`
   * - `organization` from `OPENAI_ORG_ID`
   * - `project` from `OPENAI_PROJECT_ID`
   * - `azureAdToken` from `AZURE_OPENAI_AD_TOKEN`
   * - `apiVersion` from `OPENAI_API_VERSION`
   * - `azureEndpoint` from `AZURE_OPENAI_ENDPOINT`
   */
  static withAzure(
    opts: {
      model: string | ChatModels;
      azureEndpoint?: string;
      azureDeployment?: string;
      apiVersion?: string;
      apiKey?: string;
      azureAdToken?: string;
      azureAdTokenProvider?: () => Promise<string>;
      organization?: string;
      project?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
    } = defaultAzureLLMOptions,
  ): LLM {
    opts = { ...defaultAzureLLMOptions, ...opts };
    if (opts.apiKey === undefined) {
      throw new Error('Azure API key is required, whether as an argument or as $AZURE_API_KEY');
    }

    return new LLM({
      temperature: opts.temperature,
      user: opts.user,
      client: new AzureOpenAI(opts),
    });
  }

  /**
   * Create a new instance of Cerebras LLM.
   *
   * @remarks
   * `apiKey` must be set to your Cerebras API key, either using the argument or by setting the
   * `CEREBRAS_API_KEY` environment variable.
   */
  static withCerebras(
    opts: Partial<{
      model: string | CerebrasChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.CEREBRAS_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'Cerebras API key is required, whether as an argument or as $CEREBRAS_API_KEY',
      );
    }

    return new LLM({
      model: 'llama3.1-8b',
      baseURL: 'https://api.cerebras.ai/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of Fireworks LLM.
   *
   * @remarks
   * `apiKey` must be set to your Fireworks API key, either using the argument or by setting the
   * `FIREWORKS_API_KEY` environment variable.
   */
  static withFireworks(opts: Partial<LLMOptions> = {}): LLM {
    opts.apiKey = opts.apiKey || process.env.FIREWORKS_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'Fireworks API key is required, whether as an argument or as $FIREWORKS_API_KEY',
      );
    }

    return new LLM({
      model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
      baseURL: 'https://api.fireworks.ai/inference/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of xAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your xAI API key, either using the argument or by setting the
   * `XAI_API_KEY` environment variable.
   */
  static withXAI(
    opts: Partial<{
      model: string | XAIChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.XAI_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error('xAI API key is required, whether as an argument or as $XAI_API_KEY');
    }

    return new LLM({
      model: 'grok-2-public',
      baseURL: 'https://api.x.ai/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of Groq LLM.
   *
   * @remarks
   * `apiKey` must be set to your Groq API key, either using the argument or by setting the
   * `GROQ_API_KEY` environment variable.
   */
  static withGroq(
    opts: Partial<{
      model: string | GroqChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.GROQ_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error('Groq API key is required, whether as an argument or as $GROQ_API_KEY');
    }

    return new LLM({
      model: 'llama3-8b-8192',
      baseURL: 'https://api.groq.com/openai/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of DeepSeek LLM.
   *
   * @remarks
   * `apiKey` must be set to your DeepSeek API key, either using the argument or by setting the
   * `DEEPSEEK_API_KEY` environment variable.
   */
  static withDeepSeek(
    opts: Partial<{
      model: string | DeepSeekChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'DeepSeek API key is required, whether as an argument or as $DEEPSEEK_API_KEY',
      );
    }

    return new LLM({
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of OctoAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your OctoAI API key, either using the argument or by setting the
   * `OCTOAI_TOKEN` environment variable.
   */
  static withOcto(
    opts: Partial<{
      model: string | OctoChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.OCTOAI_TOKEN;
    if (opts.apiKey === undefined) {
      throw new Error('OctoAI API key is required, whether as an argument or as $OCTOAI_TOKEN');
    }

    return new LLM({
      model: 'llama-2-13b-chat',
      baseURL: 'https://text.octoai.run/v1',
      ...opts,
    });
  }

  /** Create a new instance of Ollama LLM. */
  static withOllama(
    opts: Partial<{
      model: string;
      baseURL?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    return new LLM({
      model: 'llama-2-13b-chat',
      baseURL: 'https://text.octoai.run/v1',
      apiKey: 'ollama',
      ...opts,
    });
  }

  /**
   * Create a new instance of PerplexityAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your PerplexityAI API key, either using the argument or by setting the
   * `PERPLEXITY_API_KEY` environment variable.
   */
  static withPerplexity(
    opts: Partial<{
      model: string | PerplexityChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.PERPLEXITY_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'PerplexityAI API key is required, whether as an argument or as $PERPLEXITY_API_KEY',
      );
    }

    return new LLM({
      model: 'llama-3.1-sonar-small-128k-chat',
      baseURL: 'https://api.perplexity.ai',
      ...opts,
    });
  }

  /**
   * Create a new instance of TogetherAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your TogetherAI API key, either using the argument or by setting the
   * `TOGETHER_API_KEY` environment variable.
   */
  static withTogether(
    opts: Partial<{
      model: string | TogetherChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.TOGETHER_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'TogetherAI API key is required, whether as an argument or as $TOGETHER_API_KEY',
      );
    }

    return new LLM({
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
      baseURL: 'https://api.together.xyz/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of Telnyx LLM.
   *
   * @remarks
   * `apiKey` must be set to your Telnyx API key, either using the argument or by setting the
   * `TELNYX_API_KEY` environment variable.
   */
  static withTelnyx(
    opts: Partial<{
      model: string | TelnyxChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.TELNYX_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error('Telnyx API key is required, whether as an argument or as $TELNYX_API_KEY');
    }

    return new LLM({
      model: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
      baseURL: 'https://api.telnyx.com/v2/ai',
      ...opts,
    });
  }

  /**
   * Create a new instance of Meta Llama LLM.
   *
   * @remarks
   * `apiKey` must be set to your Meta Llama API key, either using the argument or by setting the
   * `LLAMA_API_KEY` environment variable.
   */
  static withMeta(
    opts: Partial<{
      apiKey?: string;
      baseURL?: string;
      client?: OpenAI;
      model?: string | MetaChatModels;
      temperature?: number;
      user?: string;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.LLAMA_API_KEY;
    opts.baseURL = opts.baseURL || 'https://api.llama.com/compat/v1/';
    opts.model = opts.model || 'Llama-4-Maverick-17B-128E-Instruct-FP8';

    if (opts.apiKey === undefined) {
      throw new Error(
        'Meta Llama API key is required, either as argument or set LLAMA_API_KEY environment variable',
      );
    }

    return new LLM(opts);
  }

  /**
   * Create a new instance of OVHcloud AI Endpoints LLM.
   *
   * @remarks
   * `apiKey` must be set to your OVHcloud AI Endpoints API key, either using the argument or by setting the
   * `OVHCLOUD_API_KEY` environment variable.
   */
  static withOVHcloud(opts: Partial<LLMOptions> = {}): LLM {
    opts.apiKey = opts.apiKey || process.env.OVHCLOUD_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'OVHcloud AI Endpoints API key is required, whether as an argument or as $OVHCLOUD_API_KEY',
      );
    }

    return new LLM({
      model: 'gpt-oss-120b',
      baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
      ...opts,
    });
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
  }): LLMStream {
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
      client: this.#client,
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
