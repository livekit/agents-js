// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import {
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
} from '@livekit/agents';
import { Mistral } from '@mistralai/mistralai';
import type { MistralChatModels } from './models.js';

export interface LLMOptions {
  model: string | MistralChatModels;
  apiKey?: string;
  baseURL?: string;
  client?: Mistral;
  temperature?: number;
  maxTokens?: number;
  parallelToolCalls?: boolean;
  toolChoice?: llm.ToolChoice;
}

const defaultLLMOptions: LLMOptions = {
  model: 'mistral-small-latest',
  apiKey: process.env.MISTRAL_API_KEY,
};

export class LLM extends llm.LLM {
  #opts: LLMOptions;
  #client: Mistral;

  constructor(opts: Partial<LLMOptions> = {}) {
    super();
    this.#opts = { ...defaultLLMOptions, ...opts };

    if (!this.#opts.apiKey && !this.#opts.client) {
      throw new Error(
        'Mistral API key is required, either as an argument or via MISTRAL_API_KEY env var',
      );
    }

    this.#client =
      this.#opts.client ||
      new Mistral({
        apiKey: this.#opts.apiKey,
        serverURL: this.#opts.baseURL,
      });
  }

  label(): string {
    return 'mistral.LLM';
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'api.mistral.ai';
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    parallelToolCalls,
    toolChoice,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    // Per-call overrides win over instance defaults
    const resolvedParallelToolCalls =
      parallelToolCalls !== undefined ? parallelToolCalls : this.#opts.parallelToolCalls;
    const resolvedToolChoice =
      toolChoice !== undefined ? toolChoice : this.#opts.toolChoice;

    return new LLMStream(this, {
      client: this.#client,
      opts: this.#opts,
      chatCtx,
      toolCtx,
      connOptions,
      parallelToolCalls: resolvedParallelToolCalls,
      toolChoice: resolvedToolChoice,
    });
  }
}

export class LLMStream extends llm.LLMStream {
  #client: Mistral;
  #opts: LLMOptions;
  #parallelToolCalls: boolean | undefined;
  #toolChoice: llm.ToolChoice | undefined;

  constructor(
    llmInstance: LLM,
    {
      client,
      opts,
      chatCtx,
      toolCtx,
      connOptions,
      parallelToolCalls,
      toolChoice,
    }: {
      client: Mistral;
      opts: LLMOptions;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      parallelToolCalls?: boolean;
      toolChoice?: llm.ToolChoice;
    },
  ) {
    super(llmInstance, { chatCtx, toolCtx, connOptions });
    this.#client = client;
    this.#opts = opts;
    this.#parallelToolCalls = parallelToolCalls;
    this.#toolChoice = toolChoice;
  }

  protected async run(): Promise<void> {
    try {
      const messages = buildMessages(this.chatCtx, this.logger);

      // Build tools array from toolCtx
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools: any[] | undefined =
        this.toolCtx && Object.keys(this.toolCtx).length > 0
          ? Object.entries(this.toolCtx).map(([name, func]) => ({
            type: 'function' as const,
            function: {
              name,
              description: func.description,
              parameters: llm.toJsonSchema(func.parameters, true, false),
            },
          }))
          : undefined;

      const stream = await this.#client.chat.stream(
        {
          model: this.#opts.model,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: messages as any,
          tools,
          temperature: this.#opts.temperature,
          maxTokens: this.#opts.maxTokens,
          // Only send tool-related params when tools are present
          ...(tools && {
            parallelToolCalls: this.#parallelToolCalls,
            toolChoice: toMistralToolChoice(this.#toolChoice),
          }),
        },
        {
          fetchOptions: {
            // Combine the caller's abort signal with a per-request timeout so the
            // Mistral API call always respects connOptions.timeoutMs.
            signal: AbortSignal.any([
              this.abortController.signal,
              AbortSignal.timeout(this.connOptions.timeoutMs),
            ]),
          },
        },
      );

      // Track each in-progress tool call by its stream index.
      // With parallel tool calls, Mistral sends all tool call definitions in the first
      // delta (each with an id + index), then streams argument fragments in subsequent
      // deltas identified only by index — not id. Keying by index routes each fragment
      // to the correct slot instead of corrupting a single shared "current" state.
      const inProgressCalls = new Map<number, { id: string; name: string; args: string }>();

      for await (const event of stream) {
        if (this.abortController.signal.aborted) break;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunk = event.data as any;
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};

        if (delta.toolCalls && delta.toolCalls.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const toolCall of delta.toolCalls as any[]) {
            const index: number = toolCall.index ?? 0;
            if (toolCall.id) {
              // New tool call definition — initialise its slot
              inProgressCalls.set(index, {
                id: toolCall.id,
                name: toolCall.function?.name ?? '',
                args: toolCall.function?.arguments ?? '',
              });
            } else if (toolCall.function?.arguments) {
              // Argument fragment — append to the correct slot by index
              const slot = inProgressCalls.get(index);
              if (slot) {
                slot.args += toolCall.function.arguments;
              }
            }
          }
        }

        // Flush all completed tool calls when the model finishes.
        // Check any finishReason (not just 'tool_calls'/'stop') so accumulated
        // calls are not silently lost on 'length' or 'error' terminations.
        if (choice.finishReason && inProgressCalls.size > 0) {
          for (const call of inProgressCalls.values()) {
            this.queue.put({
              id: chunk.id,
              delta: {
                role: 'assistant',
                toolCalls: [
                  llm.FunctionCall.create({
                    callId: call.id,
                    name: call.name,
                    args: call.args,
                  }),
                ],
              },
            });
          }
          inProgressCalls.clear();
        }


        // Regular streamed text
        if (typeof delta.content === 'string' && delta.content) {
          this.queue.put({
            id: chunk.id,
            delta: {
              role: 'assistant',
              content: delta.content,
            },
          });
        }

        // Usage stats
        if (chunk.usage) {
          this.queue.put({
            id: chunk.id,
            usage: {
              promptTokens: chunk.usage.promptTokens ?? 0,
              completionTokens: chunk.usage.completionTokens ?? 0,
              totalTokens: chunk.usage.totalTokens ?? 0,
              promptCachedTokens: 0,
            },
          });
        }
      }
    } catch (error: unknown) {
      // An aborted signal means the stream was intentionally closed — do not
      // wrap into APIConnectionError, which would trigger the retry loop.
      if (this.abortController.signal.aborted) throw error;

      // Re-throw errors already in the framework's error hierarchy
      if (error instanceof APIStatusError || error instanceof APIConnectionError) {
        throw error;
      }

      // Inspect the Mistral SDK error for an HTTP status code
      const err = error as { statusCode?: number; status?: number; message?: string };
      const statusCode = err.statusCode ?? err.status;

      if (statusCode !== undefined) {
        if (statusCode === 429) {
          throw new APIStatusError({
            message: `Mistral LLM: rate limit error - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
        if (statusCode >= 400 && statusCode < 500) {
          throw new APIStatusError({
            message: `Mistral LLM: client error (${statusCode}) - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: false },
          });
        }
        if (statusCode >= 500) {
          throw new APIStatusError({
            message: `Mistral LLM: server error (${statusCode}) - ${err.message ?? 'unknown error'}`,
            options: { statusCode, retryable: true },
          });
        }
      }

      // Network failure or unknown error — retryable by default
      throw new APIConnectionError({
        message: `Mistral LLM: connection error - ${err.message ?? 'unknown error'}`,
        options: { retryable: true },
      });
    }
  }
}
/**
 * Map the framework's ToolChoice type to the values Mistral's API accepts.
 *
 * Mistral supports: 'auto' | 'none' | 'any'
 * LiveKit adds:     'required'  (force at least one call)  → maps to 'any'
 *                   { type: 'function', function: { name } } (named tool) → not supported, falls back to 'any'
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMistralToolChoice(choice: llm.ToolChoice | undefined): 'auto' | 'none' | 'any' | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'auto') return 'auto';
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'any'; // Mistral's equivalent of 'required'
  // { type: 'function', function: { name } } — Mistral doesn't support named-function choice, best-effort fallback
  return 'any';
}

/**
 * Convert a LiveKit ChatContext into Mistral message format.
 *
 * Rules enforced here:
 * 1. An assistant message and its tool calls must be ONE message (content + toolCalls).
 * 2. Every tool call ID in an assistant message must have a matching tool response.
 *    Unmatched tool calls (e.g. from interrupted turns) are dropped to prevent 400s.
 * 3. Tool response messages use the FunctionCall's name (always populated), not the
 *    FunctionCallOutput's name (defaults to '').
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMessages(chatCtx: llm.ChatContext, logger?: { warn: (...args: any[]) => void }): object[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [];

  // Index tool outputs by callId for O(1) lookup
  const toolOutputsByCallId = new Map<string, llm.FunctionCallOutput>();
  for (const item of chatCtx.items) {
    if (item.type === 'function_call_output') {
      toolOutputsByCallId.set(item.callId, item);
    }
  }

  let i = 0;
  const items = chatCtx.items;

  while (i < items.length) {
    const item = items[i]!;

    if (item.type === 'message') {
      const role = item.role;
      const text = item.content
        .filter((c): c is string => {
          if (typeof c !== 'string') {
            logger?.warn(
              'Mistral plugin: non-string content (e.g. image) is not yet supported and will be dropped',
            );
            return false;
          }
          return true;
        })
        .join('\n');

      if (role === 'system' || role === 'developer') {
        messages.push({ role: 'system', content: text });
        i++;
      } else if (role === 'user') {
        messages.push({ role: 'user', content: text });
        i++;
      } else if (role === 'assistant') {
        i++;

        // Look ahead: collect any function_call items that immediately follow this
        // assistant message — they belong to the same turn and must be in ONE message.
        const toolCalls: llm.FunctionCall[] = [];
        while (i < items.length && items[i]!.type === 'function_call') {
          toolCalls.push(items[i] as llm.FunctionCall);
          i++;
        }

        if (toolCalls.length === 0) {
          // Pure text assistant message — no tool calls
          messages.push({ role: 'assistant', content: text });
        } else {
          // Mixed: text + tool calls — must be ONE assistant message
          const matchedToolCalls = toolCalls.filter((tc) => toolOutputsByCallId.has(tc.callId));
          if (matchedToolCalls.length === 0) {
            // All tool calls from this turn are unmatched (e.g. interrupted).
            // Still preserve any text the assistant spoke before calling tools.
            if (text) messages.push({ role: 'assistant', content: text });
            continue;
          }

          messages.push({
            role: 'assistant',
            content: text || null,
            toolCalls: matchedToolCalls.map((tc) => ({
              id: tc.callId,
              type: 'function',
              function: { name: tc.name, arguments: tc.args },
            })),
          });

          for (const tc of matchedToolCalls) {
            const output = toolOutputsByCallId.get(tc.callId)!;
            messages.push({
              role: 'tool',
              toolCallId: output.callId,
              content: output.output,
              name: tc.name, // use FunctionCall name — output.name defaults to ''
            });
          }
        }
      } else {
        i++;
      }
    } else if (item.type === 'function_call') {
      // Tool calls not preceded by an assistant text message in this turn
      const toolCalls: llm.FunctionCall[] = [];
      while (i < items.length && items[i]!.type === 'function_call') {
        toolCalls.push(items[i] as llm.FunctionCall);
        i++;
      }

      const matchedToolCalls = toolCalls.filter((tc) => toolOutputsByCallId.has(tc.callId));
      if (matchedToolCalls.length === 0) continue;

      messages.push({
        role: 'assistant',
        content: null,
        toolCalls: matchedToolCalls.map((tc) => ({
          id: tc.callId,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      for (const tc of matchedToolCalls) {
        const output = toolOutputsByCallId.get(tc.callId)!;
        messages.push({
          role: 'tool',
          toolCallId: output.callId,
          content: output.output,
          name: tc.name, // use FunctionCall name — output.name defaults to ''
        });
      }
    } else {
      // function_call_output (handled above) and agent_handoff (ignored)
      i++;
    }
  }

  return messages;
}
