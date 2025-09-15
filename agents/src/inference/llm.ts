// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { APIConnectOptions } from '../types.js';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  toError,
} from '../index.js';
import type { LLMModels } from './models.js';
import { createAccessToken } from './_utils.js';
import OpenAI from 'openai';

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

  constructor(opts: Partial<InferenceLLMOptions>) {
    super();
    const baseURL =
      opts.baseURL || process.env.LIVEKIT_GATEWAY_URL || DEFAULT_BASE_URL;
    const apiKey =
      opts.apiKey || process.env.LIVEKIT_GATEWAY_API_KEY || process.env.LIVEKIT_API_KEY;
    const apiSecret =
      opts.apiSecret ||
      process.env.LIVEKIT_GATEWAY_API_SECRET ||
      process.env.LIVEKIT_API_SECRET;

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
      baseURL: this.#opts.baseURL!,
      apiKey: this.#opts.apiKey!,
      apiSecret: this.#opts.apiSecret!,
      chatCtx,
      toolCtx,
      connOptions,
      extraKwargs: extras,
    });
  }
}

export class LLMStream extends llm.LLMStream {
  #toolCallId?: string;
  #fncName?: string;
  #fncRawArguments?: string;
  #toolIndex?: number;
  #extraKwargs: Record<string, any>;
  #baseURL: string;
  #apiKey: string;
  #apiSecret: string;
  #model: string | LLMModels;

  constructor(
    llm: LLM,
    {
      model,
      baseURL,
      apiKey,
      apiSecret,
      chatCtx,
      toolCtx,
      connOptions,
      extraKwargs,
    }: {
      model: string | LLMModels;
      baseURL: string;
      apiKey: string;
      apiSecret: string;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      extraKwargs: Record<string, any>;
    },
  ) {
    super(llm, { chatCtx, toolCtx, connOptions });
    this.#extraKwargs = extraKwargs;
    this.#baseURL = baseURL;
    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
    this.#model = model;
  }

  protected async run(): Promise<void> {
    let retryable = true;
    try {
      const messages = (await this.chatCtx.toProviderFormat(
        'openai',
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

      // create a short-lived JWT on each request to avoid expiration issues
      const jwt = await createAccessToken(this.#apiKey, this.#apiSecret, 600);
      const client = new OpenAI({
        baseURL: this.#baseURL,
        apiKey: jwt,
      });

      const stream = await client.chat.completions.create({
        model: this.#model as string,
        messages,
        tools,
        stream: true,
        stream_options: { include_usage: true },
        ...this.#extraKwargs,
      });

      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          if (this.abortController.signal.aborted) {
            break;
          }
          const chatChunk = this.#parseChoice(chunk.id, choice);
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
            requestId: (error as any).request_id, // eslint-disable-line @typescript-eslint/no-explicit-any
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

  #parseChoice(id: string, choice: OpenAI.ChatCompletionChunk.Choice): llm.ChatChunk | undefined {
    const delta = choice.delta;

    // Azure OpenAI may produce undefined delta when content filtered
    if (delta === undefined) return undefined;

    if (delta.tool_calls) {
      for (const tool of delta.tool_calls) {
        if (!tool.function) continue;

        let callChunk: llm.ChatChunk | undefined;
        if (this.#toolCallId && tool.id && tool.index !== this.#toolIndex) {
          callChunk = this.#createRunningToolCallChunk(id, delta);
          this.#toolCallId = this.#fncName = this.#fncRawArguments = undefined;
        }

        if (tool.function.name) {
          this.#toolIndex = tool.index;
          this.#toolCallId = tool.id;
          this.#fncName = tool.function.name;
          this.#fncRawArguments = tool.function.arguments || '';
        } else if (tool.function.arguments) {
          this.#fncRawArguments = (this.#fncRawArguments || '') + tool.function.arguments;
        }

        if (callChunk) return callChunk;
      }
    }

    if (
      choice.finish_reason &&
      ['tool_calls', 'stop'].includes(choice.finish_reason) &&
      this.#toolCallId !== undefined
    ) {
      const callChunk = this.#createRunningToolCallChunk(id, delta);
      this.#toolCallId = this.#fncName = this.#fncRawArguments = undefined;
      return callChunk;
    }

    if (!delta.content) return undefined;

    return {
      id,
      delta: { role: 'assistant', content: delta.content },
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


