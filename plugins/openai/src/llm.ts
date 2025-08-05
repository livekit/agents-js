// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, llm } from '@livekit/agents';
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
}

const defaultLLMOptions: LLMOptions = {
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  parallelToolCalls: true,
};

const defaultAzureLLMOptions: LLMOptions = {
  model: 'gpt-4o',
  apiKey: process.env.AZURE_API_KEY,
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
   * `OPENAI_API_KEY` environmental variable.
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
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
      });
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
    opts = { ...defaultLLMOptions, ...opts };
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
   * `CEREBRAS_API_KEY` environmental variable.
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
   * `FIREWORKS_API_KEY` environmental variable.
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
   * `XAI_API_KEY` environmental variable.
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
   * `GROQ_API_KEY` environmental variable.
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
   * `DEEPSEEK_API_KEY` environmental variable.
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
   * `OCTOAI_TOKEN` environmental variable.
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
   * `PERPLEXITY_API_KEY` environmental variable.
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
   * `TOGETHER_API_KEY` environmental variable.
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
   * `TELNYX_API_KEY` environmental variable.
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
   * `LLAMA_API_KEY` environmental variable.
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
        'Meta Llama API key is required, either as argument or set LLAMA_API_KEY environmental variable',
      );
    }

    return new LLM(opts);
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
    extraKwargs?: Record<string, any>;
  }): LLMStream {
    const temperature = extraKwargs?.temperature || this.#opts.temperature;

    const finalToolChoice = toolChoice || this.#opts.toolChoice;

    const finalParallelToolCalls =
      parallelToolCalls !== undefined ? parallelToolCalls : this.#opts.parallelToolCalls;

    const extra: Record<string, any> = { ...extraKwargs };

    if (this.#opts.metadata) extra.metadata = this.#opts.metadata;
    if (this.#opts.user) extra.user = this.#opts.user;
    if (this.#opts.maxCompletionTokens)
      extra.max_completion_tokens = this.#opts.maxCompletionTokens;
    if (this.#opts.serviceTier) extra.service_tier = this.#opts.serviceTier;
    if (this.#opts.store !== undefined) extra.store = this.#opts.store;

    if (temperature) extra.temperature = temperature;
    if (finalParallelToolCalls !== undefined) extra.parallel_tool_calls = finalParallelToolCalls;
    if (finalToolChoice) extra.tool_choice = finalToolChoice;

    return new LLMStream(this, {
      model: this.#opts.model,
      providerFmt: this.#providerFmt,
      client: this.#client,
      chatCtx,
      toolCtx,
      connOptions,
      extraKwargs: extra,
    });
  }
}

export class LLMStream extends llm.LLMStream {
  // Current function call that we're waiting for full completion (args are streamed)
  #toolCallId?: string;
  #fncName?: string;
  #fncRawArguments?: string;
  #toolIndex?: number;
  #client: OpenAI;
  #providerFmt: llm.ProviderFormat;
  #extraKwargs: Record<string, any>;
  label = 'openai.LLMStream';

  constructor(
    llm: LLM,
    {
      model,
      providerFmt,
      client,
      chatCtx,
      toolCtx,
      connOptions,
      extraKwargs,
    }: {
      model: string | ChatModels;
      providerFmt: llm.ProviderFormat;
      client: OpenAI;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      extraKwargs: Record<string, any>;
    },
  ) {
    super(llm, { chatCtx, toolCtx, connOptions });
    this.#client = client;
    this.#providerFmt = providerFmt;
    this.#extraKwargs = extraKwargs;
    this.#run(model);
  }

  async #run(model: string | ChatModels) {
    // Convert ToolContext to OpenAI format
    const openaiTools = this.toolCtx
      ? Object.entries(this.toolCtx).map(([name, func]) => ({
          type: 'function' as const,
          function: {
            name,
            description: func.description,
            parameters: llm.toJsonSchema(
              func.parameters,
            ) as unknown as OpenAI.Chat.Completions.ChatCompletionTool['function']['parameters'],
          },
        }))
      : undefined;

    try {
      const messages = (await this.chatCtx.toProviderFormat(
        this.#providerFmt,
      )) as OpenAI.ChatCompletionMessageParam[];

      // Clean extraKwargs to remove parallel_tool_calls if no tools are present
      const cleanedExtraKwargs = { ...this.#extraKwargs };
      if (!openaiTools || openaiTools.length === 0) {
        delete cleanedExtraKwargs.parallelToolCalls;
        delete (cleanedExtraKwargs as any).parallel_tool_calls;
      }

      const requestParams: OpenAI.ChatCompletionCreateParamsStreaming = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };

      // Add cleaned extra kwargs (avoiding parallel_tool_calls issues)
      for (const [key, value] of Object.entries(cleanedExtraKwargs)) {
        if (key !== 'parallelToolCalls' && key !== 'parallel_tool_calls') {
          (requestParams as any)[key] = value;
        }
      }

      // Only add tools-related parameters if tools are provided
      if (openaiTools && openaiTools.length > 0) {
        (requestParams as any).tools = openaiTools;
        if (this.#extraKwargs.parallelToolCalls !== undefined) {
          (requestParams as any).parallel_tool_calls = this.#extraKwargs.parallelToolCalls;
        }
      }

      const stream = await this.#client.chat.completions.create(requestParams);

      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          if (this.abortController.signal.aborted) {
            break;
          }
          const chatChunk = this.#parseChoice(chunk.id, choice);
          if (chatChunk) {
            this.queue.put(chatChunk);
          }
        }

        if (chunk.usage) {
          const usage = chunk.usage;
          this.queue.put({
            id: chunk.id,
            usage: {
              completionTokens: usage.completion_tokens,
              promptTokens: usage.prompt_tokens,
              promptCachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
              totalTokens: usage.total_tokens,
            },
          });
        }
      }
    } finally {
      this.queue.close();
    }
  }

  #parseChoice(id: string, choice: OpenAI.ChatCompletionChunk.Choice): llm.ChatChunk | undefined {
    const delta = choice.delta;

    // https://github.com/livekit/agents/issues/688
    // the delta can be None when using Azure OpenAI (content filtering)
    if (delta === undefined) return undefined;

    if (delta.tool_calls) {
      // check if we have functions to calls
      for (const tool of delta.tool_calls) {
        if (!tool.function) {
          continue; // oai may add other tools in the future
        }

        /**
         * The way OpenAI streams tool calls is a bit tricky.
         *
         * For any new tool call, it first emits a delta tool call with id, and function name,
         * the rest of the delta chunks will only stream the remaining arguments string,
         * until a new tool call is started or the tool call is finished.
         * See below for an example.
         *
         * Choice(delta=ChoiceDelta(content=None, function_call=None, refusal=None, role='assistant', tool_calls=None), finish_reason=None, index=0, logprobs=None)
         * [ChoiceDeltaToolCall(index=0, id='call_LaVeHWUHpef9K1sd5UO8TtLg', function=ChoiceDeltaToolCallFunction(arguments='', name='get_weather'), type='function')]
         * [ChoiceDeltaToolCall(index=0, id=None, function=ChoiceDeltaToolCallFunction(arguments='{"location": "P', name=None), type=None)]
         * [ChoiceDeltaToolCall(index=0, id=None, function=ChoiceDeltaToolCallFunction(arguments='aris}', name=None), type=None)]
         * [ChoiceDeltaToolCall(index=1, id='call_ThU4OmMdQXnnVmpXGOCknXIB', function=ChoiceDeltaToolCallFunction(arguments='', name='get_weather'), type='function')]
         * [ChoiceDeltaToolCall(index=1, id=None, function=ChoiceDeltaToolCallFunction(arguments='{"location": "T', name=None), type=None)]
         * [ChoiceDeltaToolCall(index=1, id=None, function=ChoiceDeltaToolCallFunction(arguments='okyo', name=None), type=None)]
         * Choice(delta=ChoiceDelta(content=None, function_call=None, refusal=None, role=None, tool_calls=None), finish_reason='tool_calls', index=0, logprobs=None)
         */
        let callChunk: llm.ChatChunk | undefined;
        // If we have a previous tool call and this is a new one, emit the previous
        if (this.#toolCallId && tool.id && tool.index !== this.#toolIndex) {
          callChunk = this.#createRunningToolCallChunk(id, delta);
          this.#toolCallId = this.#fncName = this.#fncRawArguments = undefined;
        }

        // Start or continue building the current tool call
        if (tool.function.name) {
          this.#toolIndex = tool.index;
          this.#toolCallId = tool.id;
          this.#fncName = tool.function.name;
          this.#fncRawArguments = tool.function.arguments || '';
        } else if (tool.function.arguments) {
          this.#fncRawArguments = (this.#fncRawArguments || '') + tool.function.arguments;
        }

        if (callChunk) {
          return callChunk;
        }
      }
    }

    // If we're done with tool calls, emit the final one
    if (
      choice.finish_reason &&
      ['tool_calls', 'stop'].includes(choice.finish_reason) &&
      this.#toolCallId !== undefined
    ) {
      const callChunk = this.#createRunningToolCallChunk(id, delta);
      this.#toolCallId = this.#fncName = this.#fncRawArguments = undefined;
      return callChunk;
    }

    // Regular content message
    if (!delta.content) {
      return undefined;
    }

    return {
      id,
      delta: {
        role: 'assistant',
        content: delta.content,
      },
    };
  }

  #createRunningToolCallChunk(
    id: string,
    delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
  ): llm.ChatChunk {
    return {
      id,
      delta: {
        role: 'assistant',
        content: delta.content || undefined,
        toolCalls: [
          llm.FunctionCall.create({
            callId: this.#toolCallId!,
            name: this.#fncName || '',
            args: this.#fncRawArguments || '',
          }),
        ],
      },
    };
  }
}
