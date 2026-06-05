// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, llm } from '@livekit/agents';
import axios from 'axios';
import type { ChatModels } from './models.js';

export interface LLMOptions {
  model: string | ChatModels;
  apiKey?: string;
  baseURL?: string;
  user?: string;
  temperature?: number;
}

const defaultLLMOptions: LLMOptions = {
  model: 'MiniMax-M3',
  apiKey: process.env.MINIMAX_API_KEY,
};

export class LLM extends llm.LLM {
  #opts: LLMOptions;

  constructor(opts: Partial<LLMOptions> = defaultLLMOptions) {
    super();

    this.#opts = { ...defaultLLMOptions, ...opts };
    if (this.#opts.apiKey === undefined) {
      throw new Error('MiniMax API key is required, whether as an argument or as $MINIMAX_API_KEY');
    }
  }

  label(): string {
    return 'minimax.LLM';
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'MiniMax';
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    extraKwargs,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    return new LLMStream(this, {
      model: this.#opts.model,
      apiKey: this.#opts.apiKey!,
      baseURL: this.#opts.baseURL ?? 'https://api.minimax.io',
      chatCtx,
      toolCtx,
      connOptions,
      modelOptions: extraKwargs ?? {},
    });
  }
}

export class LLMStream extends llm.LLMStream {
  #apiKey: string;
  #baseURL: string;
  #model: string;
  #modelOptions: Record<string, unknown>;

  constructor(
    llm: LLM,
    {
      model,
      apiKey,
      baseURL,
      chatCtx,
      toolCtx,
      connOptions,
      modelOptions,
    }: {
      model: string;
      apiKey: string;
      baseURL: string;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      modelOptions: Record<string, unknown>;
    },
  ) {
    super(llm, { chatCtx, toolCtx, connOptions });
    this.#apiKey = apiKey;
    this.#baseURL = baseURL;
    this.#model = model;
    this.#modelOptions = modelOptions;
  }

  protected async run(): Promise<void> {
    try {
      const messages = await this.chatCtx.toProviderFormat('openai') as Array<Record<string, unknown>>;

      // Filter messages to remove function calling artifacts that MiniMax doesn't support
      const filteredMessages = messages.map((msg) => {
        const filtered: Record<string, unknown> = { ...msg };
        // Remove function_call from assistant messages
        if (filtered.function_call) {
          delete filtered.function_call;
        }
        // Remove name field if it's a function response
        if (filtered.name && String(filtered.name).startsWith('func_')) {
          delete filtered.name;
        }
        return filtered;
      });

      // MiniMax doesn't support multiple system messages - merge them into one
      const systemMessages = filteredMessages.filter((m) => m.role === 'system');
      const nonSystemMessages = filteredMessages.filter((m) => m.role !== 'system');
      const mergedSystemContent = systemMessages
        .map((m) => String(m.content))
        .join('\n\n');

      const finalMessages = [
        ...(mergedSystemContent ? [{ role: 'system', content: mergedSystemContent }] : []),
        ...nonSystemMessages,
      ];

      // MiniMax requires at least one user message with content
      // Add a dummy "hello" message if only system messages are present
      const hasUserMessage = finalMessages.some(
        (m) => m.role === 'user' && m.content && String(m.content).trim().length > 0
      );
      if (!hasUserMessage && finalMessages.length > 0) {
        finalMessages.push({ role: 'user', content: 'hello' });
        console.log('[MiniMax LLM] Added dummy user message due to no user message found');
      }

      console.log('[MiniMax LLM] Sending messages:', JSON.stringify(finalMessages.map(m => ({ role: m.role, content: String(m.content).substring(0, 80) }))));

      // Filter out unsupported parameters that MiniMax doesn't handle
      const filteredOptions: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(this.#modelOptions)) {
        // Skip function calling params - MiniMax doesn't support OpenAI-style functions
        if (key === 'functions' || key === 'function_call' || key === 'tool_choice' || key === 'tools') {
          continue;
        }
        // Skip n parameter for chat completions
        if (key === 'n') {
          continue;
        }
        filteredOptions[key] = value;
      }

      const response = await axios.post(
        `${this.#baseURL}/v1/chat/completions`,
        {
          model: this.#model,
          messages: finalMessages,
          ...filteredOptions,
        },
        {
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: this.abortController.signal,
          timeout: this.connOptions.timeoutMs,
        },
      );

      const choices = response.data?.choices;
      if (choices && choices.length > 0) {
        const choice = choices[0];
        const message = choice?.message;
        if (message) {
          // Remove internal thinking blocks that MiniMax sometimes includes
          let content = message.content ?? '';
          // Remove <think>... blocks
          content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          // Also remove just <think> tags without closing (incomplete thinking)
          content = content.replace(/<think>[\s\S]*/g, '').trim();

          this.queue.put({
            id: response.data?.id ?? 'unknown',
            delta: {
              role: message.role ?? 'assistant',
              content: content,
            },
          });
        }
      }

      // Handle usage
      if (response.data?.usage) {
        this.queue.put({
          id: response.data?.id ?? 'unknown',
          usage: {
            completionTokens: response.data.usage.completion_tokens ?? 0,
            promptTokens: response.data.usage.prompt_tokens ?? 0,
            promptCachedTokens: 0,
            totalTokens: response.data.usage.total_tokens ?? 0,
          },
        });
      }
    } catch (error) {
      if (this.abortController.signal.aborted) return;
      throw error;
    }
  }
}