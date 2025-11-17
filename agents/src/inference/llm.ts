// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import OpenAI from 'openai';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  type Expand,
  toError,
} from '../index.js';
import * as llm from '../llm/index.js';
import type { APIConnectOptions } from '../types.js';
import { type AnyString, createAccessToken } from './utils.js';

const DEFAULT_BASE_URL = 'https://agent-gateway.livekit.cloud/v1';

export type OpenAIModels =
  | 'openai/gpt-5'
  | 'openai/gpt-5-mini'
  | 'openai/gpt-5-nano'
  | 'openai/gpt-4.1'
  | 'openai/gpt-4.1-mini'
  | 'openai/gpt-4.1-nano'
  | 'openai/gpt-4o'
  | 'openai/gpt-4o-mini'
  | 'openai/gpt-oss-120b';

export type GoogleModels = 'google/gemini-2.0-flash-lite';

export type QwenModels = 'qwen/qwen3-235b-a22b-instruct';

export type KimiModels = 'moonshotai/kimi-k2-instruct';

export type DeepSeekModels = 'deepseek-ai/deepseek-v3';

type ChatCompletionPredictionContentParam =
  Expand<OpenAI.Chat.Completions.ChatCompletionPredictionContent>;
type WebSearchOptions = Expand<OpenAI.Chat.Completions.ChatCompletionCreateParams.WebSearchOptions>;
type ToolChoice = Expand<OpenAI.Chat.Completions.ChatCompletionCreateParams['tool_choice']>;
type Verbosity = 'low' | 'medium' | 'high';

export interface ChatCompletionOptions extends Record<string, unknown> {
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  max_completion_tokens?: number;
  max_tokens?: number;
  metadata?: Record<string, string>;
  modalities?: Array<'text' | 'audio'>;
  n?: number;
  parallel_tool_calls?: boolean;
  prediction?: ChatCompletionPredictionContentParam | null;
  presence_penalty?: number;
  prompt_cache_key?: string;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  safety_identifier?: string;
  seed?: number;
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority';
  stop?: string | string[];
  store?: boolean;
  temperature?: number;
  top_logprobs?: number;
  top_p?: number;
  user?: string;
  verbosity?: Verbosity;
  web_search_options?: WebSearchOptions;

  // livekit-typed arguments
  tool_choice?: ToolChoice;
  // TODO(brian): support response format
  // response_format?: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format']
}

export type LLMModels =
  | OpenAIModels
  | GoogleModels
  | QwenModels
  | KimiModels
  | DeepSeekModels
  | AnyString;

export interface InferenceLLMOptions {
  model: LLMModels;
  provider?: string;
  baseURL: string;
  apiKey: string;
  apiSecret: string;
  modelOptions: ChatCompletionOptions;
  strictToolSchema?: boolean;
}

export interface GatewayOptions {
  apiKey: string;
  apiSecret: string;
}

/**
 * Livekit Cloud Inference LLM
 */
export class LLM extends llm.LLM {
  private client: OpenAI;
  private opts: InferenceLLMOptions;

  constructor(opts: {
    model: LLMModels;
    provider?: string;
    baseURL?: string;
    apiKey?: string;
    apiSecret?: string;
    modelOptions?: InferenceLLMOptions['modelOptions'];
    strictToolSchema?: boolean;
  }) {
    super();

    const {
      model,
      provider,
      baseURL,
      apiKey,
      apiSecret,
      modelOptions,
      strictToolSchema = false,
    } = opts;

    const lkBaseURL = baseURL || process.env.LIVEKIT_INFERENCE_URL || DEFAULT_BASE_URL;
    const lkApiKey = apiKey || process.env.LIVEKIT_INFERENCE_API_KEY || process.env.LIVEKIT_API_KEY;
    if (!lkApiKey) {
      throw new Error('apiKey is required: pass apiKey or set LIVEKIT_API_KEY');
    }

    const lkApiSecret =
      apiSecret || process.env.LIVEKIT_INFERENCE_API_SECRET || process.env.LIVEKIT_API_SECRET;
    if (!lkApiSecret) {
      throw new Error('apiSecret is required: pass apiSecret or set LIVEKIT_API_SECRET');
    }

    this.opts = {
      model,
      provider,
      baseURL: lkBaseURL,
      apiKey: lkApiKey,
      apiSecret: lkApiSecret,
      modelOptions: modelOptions || {},
      strictToolSchema,
    };

    this.client = new OpenAI({
      baseURL: this.opts.baseURL,
      apiKey: '', // leave a temporary empty string to avoid OpenAI complain about missing key
      timeout: 15000,
    });
  }

  label(): string {
    return 'inference.LLM';
  }

  get model(): string {
    return this.opts.model;
  }

  static fromModelString(modelString: string): LLM {
    return new LLM({ model: modelString });
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    parallelToolCalls,
    toolChoice,
    // TODO(AJS-270): Add response_format parameter support
    extraKwargs,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    // TODO(AJS-270): Add responseFormat parameter
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    let modelOptions: Record<string, unknown> = { ...(extraKwargs || {}) };

    parallelToolCalls =
      parallelToolCalls !== undefined
        ? parallelToolCalls
        : this.opts.modelOptions.parallel_tool_calls;

    if (toolCtx && Object.keys(toolCtx).length > 0 && parallelToolCalls !== undefined) {
      modelOptions.parallel_tool_calls = parallelToolCalls;
    }

    toolChoice =
      toolChoice !== undefined
        ? toolChoice
        : (this.opts.modelOptions.tool_choice as llm.ToolChoice | undefined);

    if (toolChoice) {
      modelOptions.tool_choice = toolChoice as ToolChoice;
    }

    // TODO(AJS-270): Add response_format support here

    modelOptions = { ...modelOptions, ...this.opts.modelOptions };

    return new LLMStream(this, {
      model: this.opts.model,
      provider: this.opts.provider,
      client: this.client,
      chatCtx,
      toolCtx,
      connOptions,
      modelOptions,
      strictToolSchema: this.opts.strictToolSchema ?? false, // default to false if not set
      gatewayOptions: {
        apiKey: this.opts.apiKey,
        apiSecret: this.opts.apiSecret,
      },
    });
  }
}

export class LLMStream extends llm.LLMStream {
  private model: LLMModels;
  private provider?: string;
  private providerFmt: llm.ProviderFormat;
  private client: OpenAI;
  private modelOptions: Record<string, unknown>;
  private strictToolSchema: boolean;

  private gatewayOptions?: GatewayOptions;
  private toolCallId?: string;
  private toolIndex?: number;
  private fncName?: string;
  private fncRawArguments?: string;

  constructor(
    llm: LLM,
    {
      model,
      provider,
      client,
      chatCtx,
      toolCtx,
      gatewayOptions,
      connOptions,
      modelOptions,
      providerFmt,
      strictToolSchema,
    }: {
      model: LLMModels;
      provider?: string;
      client: OpenAI;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      gatewayOptions?: GatewayOptions;
      connOptions: APIConnectOptions;
      modelOptions: Record<string, unknown>;
      providerFmt?: llm.ProviderFormat;
      strictToolSchema: boolean;
    },
  ) {
    super(llm, { chatCtx, toolCtx, connOptions });
    this.client = client;
    this.gatewayOptions = gatewayOptions;
    this.provider = provider;
    this.providerFmt = providerFmt || 'openai';
    this.modelOptions = modelOptions;
    this.model = model;
    this.strictToolSchema = strictToolSchema;
  }

  protected async run(): Promise<void> {
    // current function call that we're waiting for full completion (args are streamed)
    // (defined inside the run method to make sure the state is reset for each run/attempt)
    let retryable = true;
    this.toolCallId = this.fncName = this.fncRawArguments = this.toolIndex = undefined;

    try {
      const messages = (await this.chatCtx.toProviderFormat(
        this.providerFmt,
      )) as OpenAI.ChatCompletionMessageParam[];

      const tools = this.toolCtx
        ? Object.entries(this.toolCtx).map(([name, func]) => {
            const oaiParams = {
              type: 'function' as const,
              function: {
                name,
                description: func.description,
                parameters: llm.toJsonSchema(
                  func.parameters,
                  true,
                  this.strictToolSchema,
                ) as unknown as OpenAI.Chat.Completions.ChatCompletionFunctionTool['function']['parameters'],
              } as OpenAI.Chat.Completions.ChatCompletionFunctionTool['function'],
            };

            if (this.strictToolSchema) {
              oaiParams.function.strict = true;
            }

            return oaiParams;
          })
        : undefined;

      const requestOptions: Record<string, unknown> = { ...this.modelOptions };
      if (!tools) {
        delete requestOptions.tool_choice;
      }

      // Dynamically set the access token for the LiveKit Agent Gateway API
      if (this.gatewayOptions) {
        this.client.apiKey = await createAccessToken(
          this.gatewayOptions.apiKey,
          this.gatewayOptions.apiSecret,
        );
      }

      if (this.provider) {
        const extraHeaders = requestOptions.extra_headers
          ? (requestOptions.extra_headers as Record<string, string>)
          : {};
        extraHeaders['X-LiveKit-Inference-Provider'] = this.provider;
        requestOptions.extra_headers = extraHeaders;
      }

      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          tools,
          stream: true,
          stream_options: { include_usage: true },
          ...requestOptions,
        },
        {
          timeout: this.connOptions.timeoutMs,
        },
      );

      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          if (this.abortController.signal.aborted) {
            break;
          }
          const chatChunk = this.parseChoice(chunk.id, choice);
          if (chatChunk) {
            retryable = false;
            this.queue.put(chatChunk);
          }
        }

        if (chunk.usage) {
          const usage = chunk.usage;
          retryable = false;
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
    } catch (error) {
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new APITimeoutError({ options: { retryable } });
      } else if (error instanceof OpenAI.APIError) {
        throw new APIStatusError({
          message: error.message,
          options: {
            statusCode: error.status,
            body: error.error,
            requestId: error.requestID,
            retryable,
          },
        });
      } else {
        throw new APIConnectionError({
          message: toError(error).message,
          options: { retryable },
        });
      }
    } finally {
      this.queue.close();
    }
  }

  private parseChoice(
    id: string,
    choice: OpenAI.ChatCompletionChunk.Choice,
  ): llm.ChatChunk | undefined {
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
         * [ChoiceDeltaToolCall(index=0, id=None, function=ChoiceDeltaToolCallFunction(arguments='\{"location": "P', name=None), type=None)]
         * [ChoiceDeltaToolCall(index=0, id=None, function=ChoiceDeltaToolCallFunction(arguments='aris\}', name=None), type=None)]
         * [ChoiceDeltaToolCall(index=1, id='call_ThU4OmMdQXnnVmpXGOCknXIB', function=ChoiceDeltaToolCallFunction(arguments='', name='get_weather'), type='function')]
         * [ChoiceDeltaToolCall(index=1, id=None, function=ChoiceDeltaToolCallFunction(arguments='\{"location": "T', name=None), type=None)]
         * [ChoiceDeltaToolCall(index=1, id=None, function=ChoiceDeltaToolCallFunction(arguments='okyo', name=None), type=None)]
         * Choice(delta=ChoiceDelta(content=None, function_call=None, refusal=None, role=None, tool_calls=None), finish_reason='tool_calls', index=0, logprobs=None)
         */
        let callChunk: llm.ChatChunk | undefined;
        // If we have a previous tool call and this is a new one, emit the previous
        if (this.toolCallId && tool.id && tool.index !== this.toolIndex) {
          callChunk = this.createRunningToolCallChunk(id, delta);
          this.toolCallId = this.fncName = this.fncRawArguments = undefined;
        }

        // Start or continue building the current tool call
        if (tool.function.name) {
          this.toolIndex = tool.index;
          this.toolCallId = tool.id;
          this.fncName = tool.function.name;
          this.fncRawArguments = tool.function.arguments || '';
        } else if (tool.function.arguments) {
          this.fncRawArguments = (this.fncRawArguments || '') + tool.function.arguments;
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
      this.toolCallId !== undefined
    ) {
      const callChunk = this.createRunningToolCallChunk(id, delta);
      this.toolCallId = this.fncName = this.fncRawArguments = undefined;
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

  private createRunningToolCallChunk(
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
            callId: this.toolCallId || '',
            name: this.fncName || '',
            args: this.fncRawArguments || '',
          }),
        ],
      },
    };
  }
}
