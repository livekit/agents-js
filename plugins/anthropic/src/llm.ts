// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import Anthropic from '@anthropic-ai/sdk';
import type { APIConnectOptions } from '@livekit/agents';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
} from '@livekit/agents';
import type { ChatModels } from './models.js';

/** Configuration options for the Anthropic LLM plugin. */
export interface LLMOptions {
  /** The model identifier to use. */
  model: string | ChatModels;
  /** Anthropic API key. Falls back to the `ANTHROPIC_API_KEY` environment variable. */
  apiKey?: string;
  /** Custom base URL for the Anthropic API. */
  baseURL?: string;
  /** Sampling temperature. */
  temperature?: number;
  /** Pre-configured Anthropic client instance. */
  client?: Anthropic;
  /** Tool selection strategy. */
  toolChoice?: llm.ToolChoice;
  /** Whether to allow parallel tool calls. */
  parallelToolCalls?: boolean;
  /** Maximum number of tokens in the response. Defaults to 4096. */
  maxTokens?: number;
}

const defaultLLMOptions: LLMOptions = {
  model: 'claude-sonnet-4-6',
  /* eslint-disable-next-line turbo/no-undeclared-env-vars */
  apiKey: process.env.ANTHROPIC_API_KEY,
  parallelToolCalls: true,
};

/**
 * Anthropic LLM provider for LiveKit Agents.
 *
 * @remarks
 * Implements the {@link llm.LLM} interface using the Anthropic Messages API.
 * Supports streaming, tool calling, and system prompt isolation required by
 * Claude 3.5+ models.
 */
export class LLM extends llm.LLM {
  #opts: LLMOptions;
  #client: Anthropic;

  constructor(opts: Partial<LLMOptions> = defaultLLMOptions) {
    super();

    this.#opts = { ...defaultLLMOptions, ...opts };
    if (!this.#opts.apiKey && !this.#opts.client) {
      throw new Error(
        'Anthropic API key is required, whether as an argument or as $ANTHROPIC_API_KEY',
      );
    }

    this.#client =
      this.#opts.client ||
      new Anthropic({
        baseURL: this.#opts.baseURL,
        apiKey: this.#opts.apiKey,
      });
  }

  /** @returns Human-readable label for logging. */
  label(): string {
    return 'anthropic.LLM';
  }

  /** @returns The model identifier being used. */
  get model(): string {
    return this.#opts.model;
  }

  /** @returns The API provider host. */
  get provider(): string {
    try {
      const url = new URL(this.#client.baseURL);
      return url.host;
    } catch {
      return 'api.anthropic.com';
    }
  }

  /**
   * Converts a framework ChatContext into Anthropic's message format.
   *
   * @remarks
   * - System prompts are isolated into a separate `TextBlockParam[]` array
   *   (required by Claude 3.5+).
   * - `function_call` items are mapped to Anthropic `tool_use` content blocks.
   * - `function_call_output` items are mapped to `tool_result` content blocks.
   * - Consecutive same-role messages are merged to satisfy Anthropic's
   *   strict alternating-turn requirement.
   * - A dummy `(empty)` user message is injected if the conversation doesn't
   *   start with a user turn.
   */
  protected _buildAnthropicContext(chatCtx: llm.ChatContext): {
    system: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
  } {
    const system: Anthropic.TextBlockParam[] = [];
    const rawMessages: Anthropic.MessageParam[] = [];

    for (const msg of chatCtx.items) {
      if (msg.type === 'message') {
        const textContent = msg.textContent || '';
        if (msg.role === 'system') {
          system.push({ type: 'text', text: textContent });
        } else if (msg.role === 'user' || msg.role === 'assistant') {
          rawMessages.push({
            role: msg.role,
            content: textContent,
          });
        }
      } else if (msg.type === 'function_call') {
        // Map to Anthropic's tool_use content block (assistant role)
        rawMessages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: msg.callId,
              name: msg.name,
              input: JSON.parse(msg.args || '{}'),
            },
          ],
        });
      } else if (msg.type === 'function_call_output') {
        // Map to Anthropic's tool_result content block (user role)
        rawMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.callId,
              content: msg.output,
              is_error: msg.isError,
            },
          ],
        });
      }
    }

    // Merge consecutive same-role messages (Anthropic requires alternating turns)
    const messages: Anthropic.MessageParam[] = [];
    for (const msg of rawMessages) {
      const prev = messages[messages.length - 1];
      if (prev && prev.role === msg.role) {
        // Merge content into a single content array
        const prevContent = Array.isArray(prev.content)
          ? prev.content
          : [{ type: 'text' as const, text: prev.content as string }];
        const curContent = Array.isArray(msg.content)
          ? msg.content
          : [{ type: 'text' as const, text: msg.content as string }];
        prev.content = [...prevContent, ...curContent] as Anthropic.ContentBlockParam[];
      } else {
        messages.push({ ...msg });
      }
    }

    // Anthropic requires conversations to start with a user turn
    if (messages.length === 0 || messages[0]!.role !== 'user') {
      messages.unshift({ role: 'user', content: '(empty)' });
    }

    return { system, messages };
  }

  /**
   * Creates a streaming chat completion.
   *
   * @remarks
   * Maps `toolChoice` to Anthropic's format:
   * - `"required"` → `{ type: "any" }`
   * - `"none"` → clears tools
   * - `{ type: "function", function: { name } }` → `{ type: "tool", name }`
   */
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

    if (this.#opts.temperature !== undefined) extras.temperature = this.#opts.temperature;

    const { system, messages } = this._buildAnthropicContext(chatCtx);

    // Build Anthropic tool schemas
    const anthropicTools: Anthropic.Tool[] = [];
    if (toolCtx) {
      for (const [name, tool] of Object.entries(toolCtx)) {
        anthropicTools.push({
          name: name,
          description: tool.description || '',
          input_schema: tool.parameters as Anthropic.Tool.InputSchema,
        });
      }
    }

    // Map toolChoice to Anthropic format
    const resolvedToolChoice = toolChoice ?? this.#opts.toolChoice;
    if (resolvedToolChoice && anthropicTools.length > 0) {
      let anthropicToolChoice: Record<string, unknown> | undefined = { type: 'auto' };

      if (typeof resolvedToolChoice === 'string') {
        if (resolvedToolChoice === 'required') {
          anthropicToolChoice = { type: 'any' };
        } else if (resolvedToolChoice === 'none') {
          // Clear tools entirely when none is requested
          anthropicTools.length = 0;
          anthropicToolChoice = undefined;
        }
      } else if (
        typeof resolvedToolChoice === 'object' &&
        'type' in resolvedToolChoice &&
        resolvedToolChoice.type === 'function'
      ) {
        const fn = (resolvedToolChoice as { function: { name: string } }).function;
        anthropicToolChoice = { type: 'tool', name: fn.name };
      }

      if (anthropicToolChoice) {
        // Map parallelToolCalls
        const resolvedParallel = parallelToolCalls ?? this.#opts.parallelToolCalls;
        if (resolvedParallel !== undefined) {
          anthropicToolChoice.disable_parallel_tool_use = !resolvedParallel;
        }
        extras.tool_choice = anthropicToolChoice;
      }
    }

    const streamPromise = this.#client.messages.create(
      {
        model: this.#opts.model,
        messages: messages,
        system: system.length > 0 ? system : undefined,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        stream: true,
        max_tokens: this.#opts.maxTokens || 4096,
        ...extras,
      },
      { timeout: connOptions.timeoutMs },
    );

    return new LLMStream(this, streamPromise, chatCtx, toolCtx, connOptions);
  }
}

/**
 * Streaming response handler for Anthropic Messages API.
 *
 * @remarks
 * Parses SSE events including:
 * - `content_block_start` / `content_block_delta` / `content_block_stop` for text and tool use
 * - `message_start` / `message_delta` for token usage tracking
 * - Chain-of-thought `<thinking>` block filtering when tools are active
 */
export class LLMStream extends llm.LLMStream {
  #streamPromise: Promise<AsyncIterable<Anthropic.MessageStreamEvent>>;
  #toolCallId?: string;
  #fncName?: string;
  #fncRawArgs?: string;
  #requestId = '';
  #ignoringCoT = false;
  #inputTokens = 0;
  #outputTokens = 0;
  #toolCtx?: llm.ToolContext;

  constructor(
    llmInst: LLM,
    streamPromise: Promise<AsyncIterable<Anthropic.MessageStreamEvent>>,
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext | undefined,
    connOptions: APIConnectOptions,
  ) {
    super(llmInst, { chatCtx, toolCtx, connOptions });
    this.#streamPromise = streamPromise;
    this.#toolCtx = toolCtx;
  }

  protected async run(): Promise<void> {
    let retryable = true;
    try {
      const stream = await this.#streamPromise;
      for await (const event of stream) {
        if (event.type === 'message_start') {
          this.#requestId = event.message.id;
          this.#inputTokens = event.message.usage.input_tokens;
          this.#outputTokens = event.message.usage.output_tokens;
        } else if (event.type === 'message_delta') {
          this.#outputTokens += event.usage.output_tokens;
        } else if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use'
        ) {
          this.#toolCallId = event.content_block.id;
          this.#fncName = event.content_block.name;
          this.#fncRawArgs = '';
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          let text = event.delta.text;

          // Filter chain-of-thought <thinking> blocks when tools are active
          if (this.#toolCtx) {
            if (text.startsWith('<thinking>')) {
              this.#ignoringCoT = true;
            } else if (this.#ignoringCoT && text.includes('</thinking>')) {
              text = text.split('</thinking>').pop() || '';
              this.#ignoringCoT = false;
            }
          }

          if (this.#ignoringCoT) {
            continue;
          }

          this.queue.put({
            id: this.#requestId,
            delta: { role: 'assistant', content: text },
          });
          retryable = false;
        } else if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'input_json_delta'
        ) {
          this.#fncRawArgs += event.delta.partial_json;
        } else if (event.type === 'content_block_stop' && this.#toolCallId) {
          this.queue.put({
            id: this.#requestId,
            delta: {
              role: 'assistant',
              toolCalls: [
                {
                  id: '',
                  type: 'function_call',
                  callId: this.#toolCallId,
                  name: this.#fncName || '',
                  args: this.#fncRawArgs || '',
                  createdAt: Date.now(),
                  extra: {},
                  toJSON: () => ({}),
                },
              ],
            },
          });
          this.#toolCallId = undefined;
          this.#fncName = undefined;
          this.#fncRawArgs = undefined;
          retryable = false;
        }
      }

      // Emit final usage chunk
      this.queue.put({
        id: this.#requestId,
        usage: {
          completionTokens: this.#outputTokens,
          promptTokens: this.#inputTokens,
          totalTokens: this.#inputTokens + this.#outputTokens,
          promptCachedTokens: 0,
        },
      });
    } catch (e: unknown) {
      if (e instanceof Anthropic.APIError) {
        if (e.status === 408 || e.status === 409) {
          throw new APITimeoutError({
            message: e.message,
            options: { retryable },
          });
        }
        throw new APIStatusError({
          message: e.message,
          options: {
            statusCode: e.status,
            body: e.error as object,
            retryable: retryable && (e.status === 429 || e.status >= 500),
          },
        });
      }
      throw new APIConnectionError({
        message: e instanceof Error ? e.message : String(e),
        options: { retryable },
      });
    }
  }
}
