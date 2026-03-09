/**
 * Blaze LLM Plugin for LiveKit Voice Agent (Node.js)
 *
 * LLM plugin interfacing with Blaze chatbot service.
 *
 * API Endpoint: POST /voicebot/{botId}/chat-conversion?stream=true
 * Input: JSON array of { role, content } messages
 * Output: SSE stream: data: {"content": "..."} then data: [DONE]
 */

import { DEFAULT_API_CONNECT_OPTIONS, llm } from '@livekit/agents';
import type { APIConnectOptions } from '@livekit/agents';

// ChatContext and ChatMessage are in the llm namespace
type ChatContext = llm.ChatContext;
type ChatMessage = llm.ChatMessage;
import {
  type BlazeConfig,
  type ResolvedBlazeConfig,
  buildAuthHeaders,
  resolveConfig,
  MAX_RETRY_COUNT,
  RETRY_BASE_DELAY_MS,
  sleep,
  isRetryableError,
} from './config.js';
import type { BlazeChatMessage, BlazeLLMData } from './models.js';

/** Demographics for personalization. */
export interface BlazeDemographics {
  gender?: 'male' | 'female' | 'unknown';
  age?: number;
}

/** Options for the Blaze LLM plugin. */
export interface LLMOptions {
  /** Blaze chatbot identifier (required). */
  botId: string;
  /**
   * Base URL for the LLM service.
   * Falls back to config.apiUrl → BLAZE_API_URL env var.
   */
  apiUrl?: string;
  /** Bearer token for authentication. Falls back to BLAZE_AUTH_TOKEN env var. */
  authToken?: string;
  /** Enable deep search mode. Default: false */
  deepSearch?: boolean;
  /** Enable agentic search mode. Default: false */
  agenticSearch?: boolean;
  /** User demographics for personalization. */
  demographics?: BlazeDemographics;
  /** Request timeout in milliseconds. Default: 60000 */
  timeout?: number;
  /** Centralized configuration object. */
  config?: BlazeConfig;
}

interface ResolvedLLMOptions {
  botId: string;
  apiUrl: string;
  authToken: string;
  deepSearch: boolean;
  agenticSearch: boolean;
  demographics?: BlazeDemographics;
  timeout: number;
}

function resolveLLMOptions(opts: LLMOptions): ResolvedLLMOptions {
  if (!opts.botId) {
    throw new Error('Blaze LLM: botId is required');
  }
  const cfg: ResolvedBlazeConfig = resolveConfig(opts.config);
  return {
    botId:         opts.botId,
    apiUrl:        opts.apiUrl    ?? cfg.apiUrl,
    authToken:     opts.authToken ?? cfg.authToken,
    deepSearch:    opts.deepSearch    ?? false,
    agenticSearch: opts.agenticSearch ?? false,
    demographics:  opts.demographics,
    timeout:       opts.timeout   ?? cfg.llmTimeout,
  };
}

/**
 * Convert ChatContext items to Blaze API message format.
 * Only processes ChatMessage items (skips FunctionCall, FunctionCallOutput, etc.)
 *
 * System messages are collected and merged into a single context
 * message prepended to the conversation, preserving their original order.
 */
function convertMessages(chatCtx: ChatContext): BlazeChatMessage[] {
  const messages: BlazeChatMessage[] = [];
  const systemParts: string[] = [];

  for (const item of chatCtx.items) {
    // Only process ChatMessage items (type guard)
    if (!('role' in item) || !('textContent' in item)) continue;
    const msg = item as ChatMessage;
    const text = msg.textContent;
    if (!text) continue;

    const role = msg.role;
    if (role === 'system') {
      systemParts.push(text);
    } else if (role === 'user') {
      messages.push({ role: 'user', content: text });
    } else if (role === 'assistant') {
      messages.push({ role: 'assistant', content: text });
    }
  }

  // Merge all system messages and prepend as unified context
  if (systemParts.length > 0) {
    const systemText = systemParts.join('\n\n');
    messages.unshift({ role: 'user', content: `[System Instructions]\n${systemText}` });
  }

  return messages;
}

/**
 * Extract text content from SSE data in various formats.
 */
function extractContent(data: Record<string, unknown>): string | null {
  if (typeof data.content === 'string') return data.content;
  if (typeof data.text === 'string') return data.text;
  if (data.delta && typeof (data.delta as Record<string, unknown>).text === 'string') {
    return (data.delta as Record<string, unknown>).text as string;
  }
  return null;
}

/**
 * Blaze LLM Stream - async iterator that yields ChatChunk from SSE response.
 *
 * Includes retry logic with exponential backoff for transient failures.
 */
export class BlazeLLMStream extends llm.LLMStream {
  label = 'blaze.LLMStream';
  readonly #opts: ResolvedLLMOptions;

  constructor(
    llmInstance: BlazeLLM,
    opts: ResolvedLLMOptions,
    chatCtx: ChatContext,
    connOptions: APIConnectOptions,
  ) {
    super(llmInstance, { chatCtx, connOptions });
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = crypto.randomUUID();
    const messages = convertMessages(this.chatCtx);

    // Build URL with query params
    const url = new URL(`${this.#opts.apiUrl}/voicebot/${this.#opts.botId}/chat-conversion`);
    url.searchParams.set('stream', 'true');
    if (this.#opts.deepSearch) url.searchParams.set('deepSearch', 'true');
    if (this.#opts.agenticSearch) url.searchParams.set('agenticSearch', 'true');
    if (this.#opts.demographics?.gender) url.searchParams.set('gender', this.#opts.demographics.gender);
    if (this.#opts.demographics?.age !== undefined) {
      url.searchParams.set('age', String(this.#opts.demographics.age));
    }

    for (let attempt = 0; attempt <= MAX_RETRY_COUNT; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.#opts.timeout);
      const signal = AbortSignal.any([this.abortController.signal, controller.signal]);

      try {
        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildAuthHeaders(this.#opts.authToken),
          },
          body: JSON.stringify(messages),
          signal,
        });

        // Retry on 5xx server errors
        if (response.status >= 500 && attempt < MAX_RETRY_COUNT) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'unknown error');
          throw new Error(`Blaze LLM error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
          throw new Error('Blaze LLM: response body is null');
        }

        // Parse SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = '';
        let completionTokens = 0;
        let streamDone = false;

        try {
          while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;
            if (signal.aborted) break;

            lineBuffer += decoder.decode(value, { stream: true });

            // Process all complete lines
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              let rawData: string;

              if (trimmed.startsWith('data: ')) {
                rawData = trimmed.slice(6);
              } else {
                // Raw JSON line (non-SSE format fallback)
                rawData = trimmed;
              }

              if (rawData === '[DONE]') {
                streamDone = true;
                break;
              }

              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(rawData) as Record<string, unknown>;
              } catch {
                // Skip non-JSON lines (comments, keep-alives, etc.)
                continue;
              }

              const content = extractContent(parsed as BlazeLLMData as unknown as Record<string, unknown>);
              if (content) {
                completionTokens++;
                this.queue.put({
                  id: requestId,
                  delta: {
                    role: 'assistant',
                    content,
                  },
                });
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        // Emit final chunk with usage stats (approximate)
        this.queue.put({
          id: requestId,
          usage: {
            completionTokens,
            promptTokens: 0,
            promptCachedTokens: 0,
            totalTokens: completionTokens,
          },
        });

        return; // Success — exit method

      } catch (err) {
        if (attempt < MAX_RETRY_COUNT && isRetryableError(err)) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  // Required abstract method from base class
  get label_(): string { return 'blaze.LLMStream'; }
}

/**
 * Blaze LLM Plugin.
 *
 * Interfaces with the Blaze chatbot service for conversational AI.
 * Supports SSE streaming for low-latency responses.
 *
 * @example
 * ```typescript
 * import { LLM } from '@livekit/agents-plugin-blaze';
 *
 * const llm = new LLM({ botId: 'my-chatbot' });
 * // Or with shared config:
 * const llm = new LLM({
 *   botId: 'my-chatbot',
 *   config: { apiUrl: 'https://api.blaze.vn', authToken: 'tok' }
 * });
 * ```
 */
export class BlazeLLM extends llm.LLM {
  #opts: ResolvedLLMOptions;

  constructor(opts: LLMOptions) {
    super();
    this.#opts = resolveLLMOptions(opts);
  }

  label(): string {
    return 'blaze.LLM';
  }

  /**
   * Update LLM options at runtime.
   */
  updateOptions(opts: Partial<Omit<LLMOptions, 'botId' | 'config'>>): void {
    if (opts.authToken     !== undefined) this.#opts.authToken     = opts.authToken;
    if (opts.deepSearch    !== undefined) this.#opts.deepSearch    = opts.deepSearch;
    if (opts.agenticSearch !== undefined) this.#opts.agenticSearch = opts.agenticSearch;
    if (opts.demographics  !== undefined) this.#opts.demographics  = opts.demographics;
    if (opts.timeout       !== undefined) this.#opts.timeout       = opts.timeout;
  }

  chat({
    chatCtx,
    connOptions,
  }: {
    chatCtx: ChatContext;
    toolCtx?: unknown;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: unknown;
    extraKwargs?: Record<string, unknown>;
  }): BlazeLLMStream {
    return new BlazeLLMStream(
      this,
      this.#opts,
      chatCtx,
      connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    );
  }
}

// Export with conventional names
export { BlazeLLM as LLM, BlazeLLMStream as LLMStream };
