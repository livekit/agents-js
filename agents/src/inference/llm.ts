// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import OpenAI from 'openai';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  toError,
} from '../index.js';
import * as llm from '../llm/index.js';
import type { APIConnectOptions } from '../types.js';
import { type AnyModels, createAccessToken } from './utils.js';

export type AzureModels =
  // | "azure/gpt-5"
  // | "azure/gpt-5-mini"
  // | "azure/gpt-5-nano"
  'azure/gpt-4.1' | 'azure/gpt-4.1-mini' | 'azure/gpt-4.1-nano';
// | "azure/gpt-4o"
// | "azure/gpt-4o-mini"

// https://inference-docs.cerebras.ai/models/overview
export type CerebrasModels =
  // production models
  | 'cerebras/llama3.1-8b'
  | 'cerebras/llama-3.3-70b'
  | 'cerebras/llama-4-scout-17b-16e-instruct'
  | 'cerebras/gpt-oss-120b'
  | 'cerebras/qwen-3-32b'
  // preview models
  | 'cerebras/llama-4-maverick-17b-128e-instruct'
  | 'cerebras/qwen-3-235b-a22b-instruct-2507';

// https://console.groq.com/docs/models
export type GroqModels =
  // production models
  | 'groq/llama-3.1-8b-instant'
  | 'groq/llama-3.3-70b-versatile'
  | 'groq/openai/gpt-oss-120b'
  | 'groq/openai/gpt-oss-20b'
  // preview models
  | 'groq/meta-llama/llama-4-maverick-17b-128e-instruct'
  | 'groq/meta-llama/llama-4-scout-17b-16e-instruct'
  | 'groq/qwen/qwen3-32b';

// https://www.baseten.co/library/tag/llms
export type BasetenModels =
  | 'baseten/deepseek-ai/DeepSeek-V3-0324'
  | 'baseten/meta-llama/Llama-4-Scout-17B-16E-Instruct'
  | 'baseten/meta-llama/Llama-4-Maverick-17B-128E-Instruct'
  | 'baseten/moonshotai/Kimi-K2-Instruct'
  | 'baseten/openai/gpt-oss-120b'
  | 'baseten/Qwen/Qwen3-235B-A22B-Instruct-2507';

export interface AzureOptions {
  top_p?: number;
}

export interface CerebrasOptions {
  top_p?: number;
}

export interface GroqOptions {
  top_p?: number;
}

export interface BasetenOptions {
  top_p?: number;
}

export type LLMModels = AzureModels | CerebrasModels | GroqModels | BasetenModels | AnyModels;

export type LLMOptions<T extends LLMModels> = T extends AzureModels
  ? AzureOptions
  : T extends CerebrasModels
    ? CerebrasOptions
    : T extends GroqOptions
      ? GroqOptions
      : T extends BasetenOptions
        ? BasetenOptions
        : Record<string, unknown>;

export type Verbosity = 'low' | 'medium' | 'high';
const DEFAULT_BASE_URL = 'https://agent-gateway.livekit.cloud/v1';

export interface InferenceLLMOptions<TModel extends LLMModels> {
  model: TModel;
  temperature?: number;
  parallelToolCalls?: boolean;
  toolChoice?: llm.ToolChoice;
  maxCompletionTokens?: number;
  baseURL: string;
  apiKey: string;
  apiSecret: string;
  verbosity?: Verbosity;
  extraKwargs: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface GatewayOptions {
  apiKey: string;
  apiSecret: string;
}

export class LLM<TModel extends LLMModels> extends llm.LLM {
  private client: OpenAI;
  private opts: InferenceLLMOptions<TModel>;

  constructor(opts: {
    model: TModel;
    temperature?: number;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    maxCompletionTokens?: number;
    baseURL?: string;
    apiKey?: string;
    apiSecret?: string;
    maxRetries?: number;
    timeout?: number;
    verbosity?: Verbosity;
    extraKwargs?: LLMOptions<TModel>;
  }) {
    super();

    const {
      model,
      temperature,
      parallelToolCalls,
      toolChoice,
      maxCompletionTokens,
      baseURL,
      apiKey,
      apiSecret,
      maxRetries,
      timeout,
      verbosity,
      extraKwargs,
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
      temperature,
      parallelToolCalls,
      toolChoice,
      verbosity,
      maxCompletionTokens,
      baseURL: lkBaseURL,
      apiKey: lkApiKey,
      apiSecret: lkApiSecret,
      extraKwargs: extraKwargs || {},
    };

    this.client = new OpenAI({
      baseURL: this.opts.baseURL,
      maxRetries: maxRetries || 0,
      timeout: timeout || 15000,
    });
  }

  label(): string {
    return 'inference.LLM';
  }

  get model(): string {
    return this.opts.model;
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
  }): LLMStream<TModel> {
    let extras: Record<string, unknown> = { ...(extraKwargs || {}) };

    if (this.opts.maxCompletionTokens !== undefined) {
      extras.max_completion_tokens = this.opts.maxCompletionTokens;
    }
    if (this.opts.temperature !== undefined) {
      extras.temperature = this.opts.temperature;
    }
    if (this.opts.verbosity !== undefined) {
      extras.verbosity = this.opts.verbosity;
    }

    parallelToolCalls =
      parallelToolCalls !== undefined ? parallelToolCalls : this.opts.parallelToolCalls;
    if (toolCtx && Object.keys(toolCtx).length > 0 && parallelToolCalls !== undefined) {
      extras.parallel_tool_calls = parallelToolCalls;
    }

    toolChoice = toolChoice !== undefined ? toolChoice : this.opts.toolChoice;
    if (toolChoice) {
      extras.tool_choice = toolChoice;
    }

    // TODO(AJS-270): Add response_format support here

    extras = { ...extras, ...this.opts.extraKwargs };

    return new LLMStream(this, {
      model: this.opts.model,
      providerFmt: 'openai',
      client: this.client,
      chatCtx,
      toolCtx,
      connOptions,
      extraKwargs: extras,
      gatewayOptions: {
        apiKey: this.opts.apiKey,
        apiSecret: this.opts.apiSecret,
      },
    });
  }
}

export class LLMStream<TModel extends LLMModels> extends llm.LLMStream {
  private model: TModel;
  private providerFmt: llm.ProviderFormat;
  private client: OpenAI;
  private extraKwargs: Record<string, unknown>;

  private gatewayOptions?: GatewayOptions;
  private toolCallId?: string;
  private toolIndex?: number;
  private fncName?: string;
  private fncRawArguments?: string;

  constructor(
    llm: LLM<TModel>,
    {
      model,
      providerFmt,
      client,
      chatCtx,
      toolCtx,
      gatewayOptions,
      connOptions,
      extraKwargs,
    }: {
      model: TModel;
      providerFmt: llm.ProviderFormat;
      client: OpenAI;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      gatewayOptions?: GatewayOptions;
      connOptions: APIConnectOptions;
      extraKwargs: Record<string, any>;
    },
  ) {
    super(llm, { chatCtx, toolCtx, connOptions });
    this.client = client;
    this.gatewayOptions = gatewayOptions;
    this.providerFmt = providerFmt;
    this.extraKwargs = extraKwargs;
    this.model = model;
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

      const requestExtras: Record<string, unknown> = { ...this.extraKwargs };
      if (!tools) {
        delete requestExtras.tool_choice;
      }

      // Dynamically set the access token for the LiveKit Agent Gateway API
      if (this.gatewayOptions) {
        this.client.apiKey = await createAccessToken(
          this.gatewayOptions.apiKey,
          this.gatewayOptions.apiSecret,
        );
      }

      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          tools,
          stream: true,
          stream_options: { include_usage: true },
          ...requestExtras,
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
            requestId: error.request_id,
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
         * [ChoiceDeltaToolCall(index=0, id=None, function=ChoiceDeltaToolCallFunction(arguments='{"location": "P', name=None), type=None)]
         * [ChoiceDeltaToolCall(index=0, id=None, function=ChoiceDeltaToolCallFunction(arguments='aris}', name=None), type=None)]
         * [ChoiceDeltaToolCall(index=1, id='call_ThU4OmMdQXnnVmpXGOCknXIB', function=ChoiceDeltaToolCallFunction(arguments='', name='get_weather'), type='function')]
         * [ChoiceDeltaToolCall(index=1, id=None, function=ChoiceDeltaToolCallFunction(arguments='{"location": "T', name=None), type=None)]
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
