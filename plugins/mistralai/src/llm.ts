// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import {
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  shortuuid,
} from '@livekit/agents';
import { Mistral } from '@mistralai/mistralai';
import type {
  CompletionArgs,
  ConversationEvents,
  ConversationUsageInfo,
  FunctionCallEvent,
  MessageOutputEvent,
  ResponseDoneEvent,
  ResponseErrorEvent,
  ResponseStartedEvent,
  TextChunk,
} from '@mistralai/mistralai/models/components';
import type { MistralChatModels } from './models.js';

const DEFAULT_MODEL: MistralChatModels = 'ministral-8b-latest';

interface LLMOpts {
  model: MistralChatModels | string;
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

  updateOptions(opts: {
    model?: MistralChatModels | string;
    maxCompletionTokens?: number;
    temperature?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    randomSeed?: number;
    toolChoice?: llm.ToolChoice;
  }): void {
    if (opts.model !== undefined) this.#opts.model = opts.model;
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
      if (typeof resolvedToolChoice === 'object' || resolvedToolChoice === 'required') {
        completionArgs.toolChoice = 'required';
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
    });
  }
}

export class LLMStream extends llm.LLMStream {
  #client: Mistral;
  #opts: LLMOpts;
  #extraKwargs: Record<string, unknown>;

  constructor(
    llmInstance: LLM,
    {
      client,
      opts,
      chatCtx,
      toolCtx,
      connOptions,
      extraKwargs,
    }: {
      client: Mistral;
      opts: LLMOpts;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      extraKwargs: Record<string, unknown>;
    },
  ) {
    super(llmInstance, { chatCtx, toolCtx, connOptions });
    this.#client = client;
    this.#opts = opts;
    this.#extraKwargs = extraKwargs;
  }

  protected async run(): Promise<void> {
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
      if (this.toolCtx && Object.keys(this.toolCtx).length > 0) {
        for (const [name, func] of Object.entries(this.toolCtx)) {
          toolsList.push({
            type: 'function' as const,
            function: {
              name,
              description: func.description,
              parameters: llm.toJsonSchema(func.parameters, true, false),
            },
          });
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
