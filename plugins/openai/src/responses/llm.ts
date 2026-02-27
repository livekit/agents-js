// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  toError,
} from '@livekit/agents';
import OpenAI from 'openai';
import type { ChatModels } from '../models.js';

interface LLMOptions {
  model: string | ChatModels;
  apiKey?: string;
  baseURL?: string;
  client?: OpenAI;
  temperature?: number;
  parallelToolCalls?: boolean;
  toolChoice?: llm.ToolChoice;
  store?: boolean;
  metadata?: Record<string, string>;
  strictToolSchema?: boolean;
}

const defaultLLMOptions: LLMOptions = {
  model: 'gpt-4.1',
  apiKey: process.env.OPENAI_API_KEY,
  strictToolSchema: true,
};

export class LLM extends llm.LLM {
  #client: OpenAI;
  #opts: LLMOptions;

  /**
   * Create a new instance of OpenAI Responses LLM.
   *
   * @remarks
   * `apiKey` must be set to your OpenAI API key, either using the argument or by setting the
   * `OPENAI_API_KEY` environment variable.
   */
  constructor(opts: Partial<LLMOptions> = defaultLLMOptions) {
    super();

    this.#opts = { ...defaultLLMOptions, ...opts };
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
    return 'openai.responses.LLM';
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
  }): LLMStream {
    const modelOptions: Record<string, unknown> = { ...(extraKwargs || {}) };

    parallelToolCalls =
      parallelToolCalls !== undefined ? parallelToolCalls : this.#opts.parallelToolCalls;

    if (toolCtx && Object.keys(toolCtx).length > 0 && parallelToolCalls !== undefined) {
      modelOptions.parallel_tool_calls = parallelToolCalls;
    }

    toolChoice =
      toolChoice !== undefined ? toolChoice : (this.#opts.toolChoice as llm.ToolChoice | undefined);

    if (toolChoice) {
      modelOptions.tool_choice = toolChoice;
    }

    if (this.#opts.temperature !== undefined) {
      modelOptions.temperature = this.#opts.temperature;
    }

    if (this.#opts.store !== undefined) {
      modelOptions.store = this.#opts.store;
    }

    if (this.#opts.metadata) {
      modelOptions.metadata = this.#opts.metadata;
    }

    return new LLMStream(this, {
      model: this.#opts.model,
      client: this.#client,
      chatCtx,
      toolCtx,
      connOptions,
      modelOptions,
      strictToolSchema: this.#opts.strictToolSchema ?? true,
    });
  }
}

export class LLMStream extends llm.LLMStream {
  private model: string | ChatModels;
  private client: OpenAI;
  private modelOptions: Record<string, unknown>;
  private strictToolSchema: boolean;
  private responseId: string;

  constructor(
    llm: LLM,
    {
      model,
      client,
      chatCtx,
      toolCtx,
      connOptions,
      modelOptions,
      strictToolSchema,
    }: {
      model: string | ChatModels;
      client: OpenAI;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      modelOptions: Record<string, unknown>;
      strictToolSchema: boolean;
    },
  ) {
    super(llm, { chatCtx, toolCtx, connOptions });
    this.model = model;
    this.client = client;
    this.modelOptions = modelOptions;
    this.strictToolSchema = strictToolSchema;
    this.responseId = '';
  }

  protected async run(): Promise<void> {
    let retryable = true;

    try {
      const messages = (await this.chatCtx.toProviderFormat(
        'openai.responses',
      )) as OpenAI.Responses.ResponseInputItem[];

      const tools = this.toolCtx
        ? Object.entries(this.toolCtx).map(([name, func]) => {
            const oaiParams = {
              type: 'function' as const,
              name: name,
              description: func.description,
              parameters: llm.toJsonSchema(
                func.parameters,
                true,
                this.strictToolSchema,
              ) as unknown as OpenAI.Responses.FunctionTool['parameters'],
            } as OpenAI.Responses.FunctionTool;

            if (this.strictToolSchema) {
              oaiParams.strict = true;
            }

            return oaiParams;
          })
        : undefined;

      const requestOptions: Record<string, unknown> = { ...this.modelOptions };
      if (!tools) {
        delete requestOptions.tool_choice;
      }

      const stream = await this.client.responses.create(
        {
          model: this.model,
          input: messages,
          tools: tools,
          stream: true,
          ...requestOptions,
        },
        {
          timeout: this.connOptions.timeoutMs,
        },
      );

      for await (const event of stream) {
        retryable = false;
        let chunk: llm.ChatChunk | undefined;

        switch (event.type) {
          case 'error':
            this.handleError(event);
            break;
          case 'response.created':
            this.handleResponseCreated(event);
            break;
          case 'response.output_item.done':
            chunk = this.handleResponseOutputItemDone(event);
            break;
          case 'response.output_text.delta':
            chunk = this.handleResponseOutputTextDelta(event);
            break;
          case 'response.completed':
            chunk = this.handleResponseCompleted(event);
            break;
        }

        if (chunk) {
          this.queue.put(chunk);
        }
      }
    } catch (error) {
      if (
        error instanceof APIStatusError ||
        error instanceof APITimeoutError ||
        error instanceof APIConnectionError
      ) {
        throw error;
      } else if (error instanceof OpenAI.APIConnectionTimeoutError) {
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
    }
  }

  private handleError(event: OpenAI.Responses.ResponseErrorEvent): void {
    throw new APIStatusError({
      message: event.message,
      options: {
        statusCode: -1,
        retryable: false,
      },
    });
  }

  private handleResponseCreated(event: OpenAI.Responses.ResponseCreatedEvent): void {
    this.responseId = event.response.id;
  }

  private handleResponseOutputItemDone(
    event: OpenAI.Responses.ResponseOutputItemDoneEvent,
  ): llm.ChatChunk | undefined {
    let chunk: llm.ChatChunk | undefined;

    if (event.item.type === 'function_call') {
      chunk = {
        id: this.responseId,
        delta: {
          role: 'assistant',
          content: undefined,
          toolCalls: [
            llm.FunctionCall.create({
              callId: event.item.call_id || '',
              name: event.item.name,
              args: event.item.arguments,
            }),
          ],
        },
      };
    }
    return chunk;
  }

  private handleResponseOutputTextDelta(
    event: OpenAI.Responses.ResponseTextDeltaEvent,
  ): llm.ChatChunk {
    return {
      id: this.responseId,
      delta: {
        role: 'assistant',
        content: event.delta,
      },
    };
  }

  private handleResponseCompleted(
    event: OpenAI.Responses.ResponseCompletedEvent,
  ): llm.ChatChunk | undefined {
    if (event.response.usage) {
      return {
        id: this.responseId,
        usage: {
          completionTokens: event.response.usage.output_tokens,
          promptTokens: event.response.usage.input_tokens,
          promptCachedTokens: event.response.usage.input_tokens_details.cached_tokens,
          totalTokens: event.response.usage.total_tokens,
        },
      };
    }
    return undefined;
  }
}
