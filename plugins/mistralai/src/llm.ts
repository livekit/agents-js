// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  combineSignals,
  llm,
  shortuuid,
} from '@livekit/agents';
import { Mistral } from '@mistralai/mistralai';
import type {
  ChatCompletionStreamRequest,
  CompletionArgs,
  ConversationEvents,
  ConversationUsageInfo,
  DeltaMessage,
  FunctionCallEvent,
  MessageOutputEvent,
  ResponseDoneEvent,
  ResponseErrorEvent,
  ResponseStartedEvent,
  TextChunk,
} from '@mistralai/mistralai/models/components';
import { RequestTimeoutError } from '@mistralai/mistralai/models/errors';
import type { MistralChatModels } from './models.js';
import { MistralTool } from './tools.js';

const DEFAULT_MODEL: MistralChatModels = 'ministral-8b-latest';

export enum ApiMode {
  CONVERSATIONS = 'conversations',
  CHAT_COMPLETIONS = 'chat_completions',
}

function parseApiMode(apiMode: ApiMode | `${ApiMode}`): ApiMode {
  if (apiMode === ApiMode.CONVERSATIONS || apiMode === ApiMode.CHAT_COMPLETIONS) {
    return apiMode as ApiMode;
  }
  throw new Error(`Invalid Mistral API mode: ${apiMode}`);
}

interface LLMOpts {
  model: MistralChatModels | string;
  apiMode: ApiMode;
  maxCompletionTokens: number | null;
  temperature: number | null;
  topP: number | null;
  presencePenalty: number | null;
  frequencyPenalty: number | null;
  randomSeed: number | null;
  toolChoice: llm.ToolChoice | null;
}

interface PendingFunctionCall {
  id: string;
  name: string;
  toolCallId: string;
  arguments: string;
}

export interface LLMOptions {
  model?: MistralChatModels | string;
  apiMode?: ApiMode | `${ApiMode}`;
  apiKey?: string;
  client?: Mistral;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  randomSeed?: number;
  toolChoice?: llm.ToolChoice;
  maxCompletionTokens?: number;
}

export class LLM extends llm.LLM {
  #opts: LLMOpts;
  #client: Mistral;

  constructor(opts: LLMOptions = {}) {
    super();

    this.#opts = {
      model: opts.model ?? DEFAULT_MODEL,
      apiMode: opts.apiMode !== undefined ? parseApiMode(opts.apiMode) : ApiMode.CONVERSATIONS,
      temperature: opts.temperature ?? null,
      topP: opts.topP ?? null,
      presencePenalty: opts.presencePenalty ?? null,
      frequencyPenalty: opts.frequencyPenalty ?? null,
      randomSeed: opts.randomSeed ?? null,
      toolChoice: opts.toolChoice ?? null,
      maxCompletionTokens: opts.maxCompletionTokens ?? null,
    };

    const apiKey = opts.apiKey ?? process.env.MISTRAL_API_KEY;
    if (!opts.client && !apiKey) {
      throw new Error('Mistral AI API key is required. Set MISTRAL_API_KEY or pass apiKey');
    }

    this.#client = opts.client ?? new Mistral({ apiKey });
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

  protected override async _prewarmImpl(signal: AbortSignal): Promise<void> {
    await this.#client.models.list(undefined, { signal });
  }

  updateOptions(opts: {
    model?: MistralChatModels | string;
    apiMode?: ApiMode | `${ApiMode}`;
    maxCompletionTokens?: number;
    temperature?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    randomSeed?: number;
    toolChoice?: llm.ToolChoice;
  }): void {
    if (opts.model !== undefined) this.#opts.model = opts.model;
    if (opts.apiMode !== undefined) this.#opts.apiMode = parseApiMode(opts.apiMode);
    if (opts.maxCompletionTokens !== undefined)
      this.#opts.maxCompletionTokens = opts.maxCompletionTokens;
    if (opts.temperature !== undefined) this.#opts.temperature = opts.temperature;
    if (opts.topP !== undefined) this.#opts.topP = opts.topP;
    if (opts.presencePenalty !== undefined) this.#opts.presencePenalty = opts.presencePenalty;
    if (opts.frequencyPenalty !== undefined) this.#opts.frequencyPenalty = opts.frequencyPenalty;
    if (opts.randomSeed !== undefined) this.#opts.randomSeed = opts.randomSeed;
    if (opts.toolChoice !== undefined) this.#opts.toolChoice = opts.toolChoice;
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
    toolCtx?: llm.ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    const extra: Record<string, unknown> = {};
    if (extraKwargs) Object.assign(extra, extraKwargs);

    // Build CompletionArgs
    const completionArgs: CompletionArgs = {};
    if (this.#opts.maxCompletionTokens !== null)
      completionArgs.maxTokens = this.#opts.maxCompletionTokens;
    if (this.#opts.temperature !== null) completionArgs.temperature = this.#opts.temperature;
    if (this.#opts.topP !== null) completionArgs.topP = this.#opts.topP;
    if (this.#opts.presencePenalty !== null)
      completionArgs.presencePenalty = this.#opts.presencePenalty;
    if (this.#opts.frequencyPenalty !== null)
      completionArgs.frequencyPenalty = this.#opts.frequencyPenalty;
    if (this.#opts.randomSeed !== null) completionArgs.randomSeed = this.#opts.randomSeed;

    // Resolve tool choice
    const resolvedToolChoice = toolChoice ?? this.#opts.toolChoice;
    if (resolvedToolChoice !== null && resolvedToolChoice !== undefined) {
      const hasProviderTools =
        toolCtx !== undefined &&
        llm.toToolContext(toolCtx).providerTools.some((tool) => tool instanceof MistralTool);
      if (typeof resolvedToolChoice === 'object' || resolvedToolChoice === 'required') {
        completionArgs.toolChoice = hasProviderTools ? 'auto' : 'required';
      } else if (resolvedToolChoice === 'auto' || resolvedToolChoice === 'none') {
        completionArgs.toolChoice = resolvedToolChoice;
      }
    }

    if (Object.keys(completionArgs).length > 0) {
      extra.completionArgs = completionArgs;
    }

    return new LLMStream(this, {
      client: this.#client,
      opts: this.#opts,
      chatCtx,
      toolCtx,
      connOptions,
      extraKwargs: extra,
      toolChoice: resolvedToolChoice ?? undefined,
      parallelToolCalls,
    });
  }
}

export class LLMStream extends llm.LLMStream {
  #client: Mistral;
  #opts: LLMOpts;
  #extraKwargs: Record<string, unknown>;
  #toolChoice?: llm.ToolChoice;
  #parallelToolCalls?: boolean;

  constructor(
    llmInstance: LLM,
    {
      client,
      opts,
      chatCtx,
      toolCtx,
      connOptions,
      extraKwargs,
      toolChoice,
      parallelToolCalls,
    }: {
      client: Mistral;
      opts: LLMOpts;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContextLike;
      connOptions: APIConnectOptions;
      extraKwargs: Record<string, unknown>;
      toolChoice?: llm.ToolChoice;
      parallelToolCalls?: boolean;
    },
  ) {
    super(llmInstance, { chatCtx, toolCtx, connOptions });
    this.#client = client;
    this.#opts = opts;
    this.#extraKwargs = extraKwargs;
    this.#toolChoice = toolChoice;
    this.#parallelToolCalls = parallelToolCalls;
  }

  protected async run(): Promise<void> {
    if (this.#opts.apiMode === ApiMode.CHAT_COMPLETIONS) {
      await this.#runChatCompletions();
    } else {
      await this.#runConversations();
    }
  }

  async #runConversations(): Promise<void> {
    let retryable = true;

    try {
      const [entries, extraData] = (await this.chatCtx.toProviderFormat('mistralai')) as [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Record<string, any>[],
        { instructions: string },
      ];
      const { instructions } = extraData;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolsList: any[] = [];
      if (this.toolCtx) {
        for (const [name, func] of llm.sortedToolEntries(this.toolCtx)) {
          toolsList.push({
            type: 'function' as const,
            function: {
              name,
              description: func.description,
              parameters: llm.toJsonSchema(func.parameters, true, false),
            },
          });
        }
        for (const tool of this.toolCtx.providerTools) {
          if (tool instanceof MistralTool) toolsList.push(tool.toJSON());
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const startKwargs: Record<string, any> = {};
      if (toolsList.length > 0) startKwargs.tools = toolsList;

      // Always start a fresh conversation with the full message history (stateless usage)
      const asyncResponse = await this.#client.beta.conversations.startStream(
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inputs: entries as any,
          model: this.#opts.model,
          instructions: instructions || undefined,
          ...startKwargs,
          ...this.#extraKwargs,
        },
        { timeoutMs: this._connOptions.timeoutMs },
      );

      const pendingFncCalls = new Map<string, PendingFunctionCall>();

      for await (const ev of asyncResponse) {
        if (this.abortController.signal.aborted) break;
        const chunks = this.#parseEvent(ev, pendingFncCalls);
        for (const chunk of chunks) {
          retryable = false;
          this.queue.put(chunk);
        }
      }

      for (const chunk of this.#flushPendingFncCalls(pendingFncCalls)) {
        this.queue.put(chunk);
      }
    } catch (error: unknown) {
      if (this.abortController.signal.aborted) throw error;

      if (error instanceof APIStatusError) {
        throw new APIStatusError({
          message: error.message,
          options: { statusCode: error.statusCode, retryable: retryable && error.retryable },
        });
      }

      const err = error as { statusCode?: number; status?: number; message?: string };
      const statusCode = err.statusCode ?? err.status;

      if (statusCode !== undefined) {
        throw new APIStatusError({
          message: `Mistral LLM: error (${statusCode}) - ${err.message ?? 'unknown error'}`,
          options: { statusCode, retryable },
        });
      }

      throw new APIConnectionError({
        message: `Mistral LLM: connection error - ${err.message ?? 'unknown error'}`,
        options: { retryable },
      });
    }
  }

  async #runChatCompletions(): Promise<void> {
    if (this.toolCtx?.providerTools.some((tool) => tool instanceof MistralTool)) {
      throw new Error(
        "Provider tools (WebSearch, DocumentLibrary, CodeInterpreter, Connector) are not supported with apiMode='chat_completions'. Use apiMode='conversations' or remove provider tools.",
      );
    }

    let retryable = true;

    try {
      const openaiMessages = (await this.chatCtx.toProviderFormat('openai')) as Record<
        string,
        unknown
      >[];
      const messages = toMistralChatMessages(openaiMessages);
      const tools: Record<string, unknown>[] = [];
      if (this.toolCtx) {
        for (const [name, func] of llm.sortedToolEntries(this.toolCtx)) {
          tools.push({
            type: 'function',
            function: {
              name,
              description: func.description,
              parameters: llm.toJsonSchema(func.parameters, true, false),
            },
          });
        }
      }

      const { completionArgs, ...extraKwargs } = this.#extraKwargs as {
        completionArgs?: CompletionArgs;
        [key: string]: unknown;
      };
      const request = {
        model: this.#opts.model,
        messages,
        ...completionArgs,
        ...(this.#toolChoice !== undefined ? { toolChoice: this.#toolChoice } : {}),
        ...(this.#parallelToolCalls !== undefined
          ? { parallelToolCalls: this.#parallelToolCalls }
          : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...extraKwargs,
      } as ChatCompletionStreamRequest;

      const response = await this.#client.chat.stream(request, {
        signal: combineSignals(
          this.abortController.signal,
          AbortSignal.timeout(this._connOptions.timeoutMs),
        ),
      });
      const pendingFncCalls = new Map<number, PendingFunctionCall>();

      for await (const ev of response) {
        if (this.abortController.signal.aborted) break;
        for (const choice of ev.data.choices) {
          for (const chunk of parseCompletionDelta(
            ev.data.id,
            choice.delta,
            choice.finishReason,
            pendingFncCalls,
          )) {
            retryable = false;
            this.queue.put(chunk);
          }
        }

        if (ev.data.usage) {
          this.queue.put({
            id: ev.data.id,
            usage: {
              completionTokens: ev.data.usage.completionTokens ?? 0,
              promptTokens: ev.data.usage.promptTokens ?? 0,
              totalTokens: ev.data.usage.totalTokens ?? 0,
              promptCachedTokens: 0,
            },
          });
        }
      }

      for (const chunk of flushPendingByIndex(pendingFncCalls)) this.queue.put(chunk);
    } catch (error: unknown) {
      if (this.abortController.signal.aborted) throw error;
      if (
        error instanceof RequestTimeoutError ||
        (error instanceof Error && error.name === 'TimeoutError')
      ) {
        throw new APITimeoutError({
          message: error.message,
          options: { retryable },
        });
      }
      if (error instanceof APIStatusError) {
        throw new APIStatusError({
          message: error.message,
          options: { statusCode: error.statusCode, retryable: retryable && error.retryable },
        });
      }

      const err = error as {
        statusCode?: number;
        status?: number;
        message?: string;
        body?: string;
      };
      const statusCode = err.statusCode ?? err.status;
      if (statusCode !== undefined) {
        throw new APIStatusError({
          message: err.message ?? 'Mistral API error',
          options: {
            statusCode,
            body: err.body ? { raw: err.body } : null,
            retryable: retryable && (statusCode === 408 || statusCode === 429 || statusCode >= 500),
          },
        });
      }

      throw new APIConnectionError({
        message: `Mistral LLM: connection error - ${err.message ?? 'unknown error'}`,
        options: { retryable },
      });
    }
  }

  #flushPendingFncCalls(pending: Map<string, PendingFunctionCall>): llm.ChatChunk[] {
    const chunks: llm.ChatChunk[] = [];
    for (const fnc of pending.values()) {
      chunks.push({
        id: fnc.id,
        delta: {
          role: 'assistant',
          toolCalls: [
            llm.FunctionCall.create({
              name: fnc.name,
              args: fnc.arguments,
              callId: fnc.toolCallId,
            }),
          ],
        },
      });
    }
    pending.clear();
    return chunks;
  }

  #parseEvent(
    ev: ConversationEvents,
    pendingFncCalls: Map<string, PendingFunctionCall>,
  ): llm.ChatChunk[] {
    const data = ev.data;
    const chunks: llm.ChatChunk[] = [];

    if ((data as ResponseStartedEvent).type === 'conversation.response.started') {
      return chunks;
    }

    if ((data as FunctionCallEvent).type === 'function.call.delta') {
      const fncData = data as FunctionCallEvent;
      const existing = pendingFncCalls.get(fncData.id);
      if (!existing) {
        pendingFncCalls.set(fncData.id, {
          id: fncData.id,
          name: fncData.name,
          toolCallId: fncData.toolCallId || shortuuid('tool_call_'),
          arguments: fncData.arguments,
        });
      } else {
        existing.arguments += fncData.arguments;
      }
      return chunks;
    }

    // Any non-FunctionCallEvent flushes pending function calls
    chunks.push(...this.#flushPendingFncCalls(pendingFncCalls));

    if ((data as MessageOutputEvent).type === 'message.output.delta') {
      const msgData = data as MessageOutputEvent;
      const content = msgData.content;
      let text: string | undefined;

      if (typeof content === 'string') {
        text = content;
      } else if (content && typeof content === 'object' && 'text' in content) {
        text = (content as TextChunk).text;
      }

      if (text) {
        chunks.push({
          id: msgData.id,
          delta: { content: text, role: 'assistant' },
        });
      }
      return chunks;
    }

    if ((data as ResponseDoneEvent).type === 'conversation.response.done') {
      const usage = (data as ResponseDoneEvent).usage as ConversationUsageInfo;
      chunks.push({
        id: shortuuid('done_'),
        usage: {
          completionTokens: usage.completionTokens ?? 0,
          promptTokens: usage.promptTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
          promptCachedTokens: 0,
        },
      });
      return chunks;
    }

    if ((data as ResponseErrorEvent).type === 'conversation.response.error') {
      const errData = data as ResponseErrorEvent;
      throw new APIStatusError({
        message: errData.message,
        options: { statusCode: errData.code, retryable: false },
      });
    }

    return chunks;
  }
}

function toMistralChatMessages(
  messages: Record<string, unknown>[],
): ChatCompletionStreamRequest['messages'] {
  return messages.map((message) => {
    const { tool_calls: toolCalls, tool_call_id: toolCallId, ...rest } = message;
    const converted: Record<string, unknown> = {
      ...rest,
      role: rest.role === 'developer' ? 'system' : rest.role,
    };

    if (Array.isArray(rest.content)) {
      converted.content = rest.content.map((chunk) => {
        if (typeof chunk === 'object' && chunk !== null && 'image_url' in chunk) {
          const { image_url: imageUrl, ...chunkRest } = chunk as Record<string, unknown>;
          return { ...chunkRest, imageUrl };
        }
        return chunk;
      });
    }

    if (Array.isArray(toolCalls)) {
      converted.toolCalls = toolCalls.map((toolCall) => {
        const { extra_content: _extraContent, ...call } = toolCall as Record<string, unknown>;
        return call;
      });
    }
    if (toolCallId !== undefined) converted.toolCallId = toolCallId;

    return converted;
  }) as ChatCompletionStreamRequest['messages'];
}

function parseCompletionDelta(
  chunkId: string,
  delta: DeltaMessage,
  finishReason: string | null,
  pendingFncCalls: Map<number, PendingFunctionCall>,
): llm.ChatChunk[] {
  const chunks: llm.ChatChunk[] = [];
  const content = delta.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((chunk) => chunk.type === 'text')
            .map((chunk) => ('text' in chunk ? chunk.text : ''))
            .join('')
        : '';
  if (text) chunks.push({ id: chunkId, delta: { content: text, role: 'assistant' } });

  for (const toolCall of delta.toolCalls ?? []) {
    const callIndex = toolCall.index ?? Math.max(-1, ...pendingFncCalls.keys()) + 1;
    const args =
      typeof toolCall.function.arguments === 'string'
        ? toolCall.function.arguments
        : JSON.stringify(toolCall.function.arguments);
    const pending = pendingFncCalls.get(callIndex);
    if (!pending) {
      pendingFncCalls.set(callIndex, {
        id: chunkId,
        name: toolCall.function.name,
        toolCallId: toolCall.id && toolCall.id !== 'null' ? toolCall.id : '',
        arguments: args,
      });
    } else {
      if (toolCall.function.name) pending.name = toolCall.function.name;
      pending.arguments += args;
    }
  }

  if (finishReason === 'tool_calls') chunks.push(...flushPendingByIndex(pendingFncCalls));
  return chunks;
}

function flushPendingByIndex(pending: Map<number, PendingFunctionCall>): llm.ChatChunk[] {
  const chunks = [...pending.values()].map((fnc) => ({
    id: fnc.id,
    delta: {
      role: 'assistant' as const,
      toolCalls: [
        llm.FunctionCall.create({
          name: fnc.name,
          args: fnc.arguments,
          callId: fnc.toolCallId,
        }),
      ],
    },
  }));
  pending.clear();
  return chunks;
}
