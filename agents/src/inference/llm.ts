// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming.mjs';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  toError,
} from '../index.js';
import type { APIConnectOptions } from '../types.js';
import type { LLMModels } from './models.js';

export interface InferenceLLMOptions {
  model: string | LLMModels;
  temperature?: number;
  topP?: number;
  parallelToolCalls?: boolean;
  toolChoice?: llm.ToolChoice;
  maxCompletionTokens?: number;
  baseURL?: string;
  apiKey?: string;
  apiSecret?: string;
  extraKwargs?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const DEFAULT_BASE_URL = 'https://agent-gateway.livekit.cloud/v1';

export class LLM extends llm.LLM {
  #opts: InferenceLLMOptions;
  private client: OpenAI;

  constructor(opts: Partial<InferenceLLMOptions>) {
    super();
    const baseURL = opts.baseURL || process.env.LIVEKIT_GATEWAY_URL || DEFAULT_BASE_URL;
    const apiKey =
      opts.apiKey || process.env.LIVEKIT_GATEWAY_API_KEY || process.env.LIVEKIT_API_KEY;
    const apiSecret =
      opts.apiSecret || process.env.LIVEKIT_GATEWAY_API_SECRET || process.env.LIVEKIT_API_SECRET;

    if (!apiKey) {
      throw new Error(
        'apiKey is required: pass apiKey or set LIVEKIT_API_KEY/LIVEKIT_GATEWAY_API_KEY',
      );
    }
    if (!apiSecret) {
      throw new Error(
        'apiSecret is required: pass apiSecret or set LIVEKIT_API_SECRET/LIVEKIT_GATEWAY_API_SECRET',
      );
    }

    this.#opts = {
      model: opts.model || 'openai/gpt-4o-mini',
      temperature: opts.temperature,
      topP: opts.topP,
      parallelToolCalls: opts.parallelToolCalls,
      toolChoice: opts.toolChoice,
      maxCompletionTokens: opts.maxCompletionTokens,
      baseURL,
      apiKey,
      apiSecret,
      extraKwargs: opts.extraKwargs || {},
    };

    // Base OpenAI client pointed at Agent Gateway; per-request auth via header override
    this.client = new OpenAI({ baseURL, apiKey: 'placeholder' });
  }

  label(): string {
    return 'inference.LLM';
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
    extraKwargs?: Record<string, any>;
  }): LLMStream {
    const extras: Record<string, any> = { ...(extraKwargs || {}) }; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (this.#opts.maxCompletionTokens !== undefined) {
      extras.max_completion_tokens = this.#opts.maxCompletionTokens;
    }
    if (this.#opts.temperature !== undefined) {
      extras.temperature = this.#opts.temperature;
    }
    if (this.#opts.topP !== undefined) {
      extras.top_p = this.#opts.topP;
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

    return new LLMStream(this, {
      model: this.#opts.model,
      providerFmt: 'openai',
      client: this.client,
      chatCtx,
      toolCtx,
      connOptions,
      extraKwargs: extras,
    });
  }
}

type OAIStream = Stream<OpenAI.Chat.Completions.ChatCompletionChunk> & {
  _request_id?: string | null;
};

export class LLMStream extends llm.LLMStream {
  private model: string | LLMModels;
  private providerFmt: llm.ProviderFormat;
  private client: OpenAI;
  private extraKwargs: Record<string, any>;

  private toolCallId?: string;
  private toolIndex?: number;
  private fncName?: string;
  private fncRawArguments?: string;
  private oaiStream?: OAIStream;

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
      model: LLMModels | string;
      providerFmt: llm.ProviderFormat;
      client: OpenAI;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      extraKwargs: Record<string, any>;
    },
  ) {
    super(llm, { chatCtx, toolCtx, connOptions });
    this.client = client;
    this.providerFmt = providerFmt;
    this.extraKwargs = extraKwargs;
    this.model = model;
  }

  protected async run(): Promise<void> {
    // current function call that we're waiting for full completion (args are streamed)
    // (defined inside the run method to make sure the state is reset for each run/attempt)
    let retryable = true;
    this.oaiStream =
      this.toolCallId =
      this.fncName =
      this.fncRawArguments =
      this.toolIndex =
        undefined;

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

      const requestExtras: Record<string, any> = { ...this.extraKwargs }; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!tools) {
        delete requestExtras.tool_choice;
      }

      // Mint short-lived JWT for Agent Gateway and send via header override
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
      this.oaiStream = stream;

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
