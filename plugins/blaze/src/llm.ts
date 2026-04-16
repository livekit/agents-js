// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Blaze LLM Plugin for LiveKit Voice Agent (Node.js)
 *
 * LLM plugin interfacing with Blaze chatbot service.
 *
 * API Endpoint: POST `/v1/voicebot-call/{botId}/chat-conversion-stream`
 * Input: JSON array of `{ role, content }` messages
 * Output: SSE stream: `data: {"content": "..."}` then `data: [DONE]`
 */
import { DEFAULT_API_CONNECT_OPTIONS, llm } from '@livekit/agents';
import type { APIConnectOptions } from '@livekit/agents';
import {
  type BlazeConfig,
  BlazeHttpError,
  MAX_RETRY_COUNT,
  RETRY_BASE_DELAY_MS,
  type ResolvedBlazeConfig,
  buildAuthHeaders,
  isRetryableError,
  resolveConfig,
  sleep,
} from './config.js';
import type { BlazeChatMessage, BlazeLLMData } from './models.js';

// ChatContext and ChatMessage are in the llm namespace
type ChatContext = llm.ChatContext;
type ChatMessage = llm.ChatMessage;

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
  /** Bearer token for authentication. Falls back to BLAZE_API_TOKEN env var. */
  authToken?: string;
  /** Enable deep search mode. Default: false */
  deepSearch?: boolean;
  /** Enable agentic search mode. Default: false */
  agenticSearch?: boolean;
  /**
   * Enable tool/function calling (`use_tool_based` query param).
   * When false the Blaze backend uses a simpler response path. Default: false
   */
  enableTools?: boolean;
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
  enableTools: boolean;
  demographics?: BlazeDemographics;
  timeout: number;
}

function snapshotLLMOptions(opts: ResolvedLLMOptions): ResolvedLLMOptions {
  return {
    ...opts,
    demographics: opts.demographics ? { ...opts.demographics } : undefined,
  };
}

function resolveLLMOptions(opts: LLMOptions): ResolvedLLMOptions {
  if (!opts.botId) {
    throw new Error('Blaze LLM: botId is required');
  }
  const cfg: ResolvedBlazeConfig = resolveConfig(opts.config);
  return {
    botId: opts.botId,
    apiUrl: opts.apiUrl ?? cfg.apiUrl,
    authToken: opts.authToken ?? cfg.authToken,
    deepSearch: opts.deepSearch ?? false,
    agenticSearch: opts.agenticSearch ?? false,
    enableTools: opts.enableTools ?? false,
    demographics: opts.demographics,
    timeout: opts.timeout ?? cfg.llmTimeout,
  };
}

/**
 * Convert ChatContext items to Blaze API message format.
 * Only processes ChatMessage items (skips FunctionCall, FunctionCallOutput, etc.)
 *
 * System/developer messages are SKIPPED because the Blaze chatapp already
 * loads the voicebot prompt from the database and applies voice/chat mode
 * extraction. Sending them again would cause double-prompting (2x tokens)
 * and format conflicts (chat-mode template leaking into voice responses).
 */
function convertMessages(chatCtx: ChatContext): BlazeChatMessage[] {
  const messages: BlazeChatMessage[] = [];

  for (const item of chatCtx.items) {
    // Only process ChatMessage items (type guard)
    if (!('role' in item) || !('textContent' in item)) continue;
    const msg = item as ChatMessage;
    const text = msg.textContent;
    if (!text) continue;

    const role = msg.role;
    // Skip system/developer — chatapp loads prompt from DB
    if (role === 'system' || role === 'developer') {
      continue;
    } else if (role === 'user') {
      messages.push({ role: 'user', content: text });
    } else if (role === 'assistant') {
      // Strip <img> tags — only meaningful for TTS/rendering, not for LLM context
      const clean = text.replace(/<img>[^<]*<\/img>/gi, '').trim();
      if (clean) {
        messages.push({ role: 'assistant', content: clean });
      }
    }
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
  readonly #llm: BlazeLLM;

  constructor(
    llmInstance: BlazeLLM,
    opts: ResolvedLLMOptions,
    chatCtx: ChatContext,
    connOptions: APIConnectOptions,
  ) {
    super(llmInstance, { chatCtx, connOptions });
    this.#opts = opts;
    this.#llm = llmInstance;
  }

  /**
   * Emit a non-recoverable error on the LLM instance.
   *
   * Errors from run() must be surfaced via the LLM's 'error' event rather
   * than thrown, because the base class starts run() via a fire-and-forget
   * setTimeout (startSoon). Throwing from run() would propagate as an
   * unhandled promise rejection; emitting lets callers handle it through the
   * standard EventEmitter 'error' channel that voice agents already listen on.
   */
  #emitHttpError(error: Error): void {
    this.#llm.emit('error', {
      type: 'llm_error',
      timestamp: Date.now(),
      label: this.#llm.label(),
      error,
      recoverable: false,
    });
  }

  protected async run(): Promise<void> {
    const requestId = crypto.randomUUID();
    const messages = convertMessages(this.chatCtx);

    // Build URL with query params
    const url = new URL(
      `${this.#opts.apiUrl}/v1/voicebot-call/${this.#opts.botId}/chat-conversion-stream`,
    );
    url.searchParams.set('is_voice_call', 'true');
    url.searchParams.set('agent_stream', 'true');
    url.searchParams.set('use_tool_based', this.#opts.enableTools ? 'true' : 'false');
    if (this.#opts.deepSearch) url.searchParams.set('deep_search', 'true');
    if (this.#opts.agenticSearch) url.searchParams.set('agentic_search', 'true');
    if (this.#opts.demographics?.gender)
      url.searchParams.set('gender', this.#opts.demographics.gender);
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
          this.#emitHttpError(new BlazeHttpError(response.status, `Blaze LLM error ${response.status}: ${errorText}`));
          return;
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

              const content = extractContent(
                parsed as BlazeLLMData as unknown as Record<string, unknown>,
              );
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
        // Emit error via the LLM instance instead of throwing to avoid
        // unhandled promise rejection from the fire-and-forget startSoon task.
        this.#emitHttpError(err instanceof Error ? err : new Error(String(err)));
        return;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  // Required abstract method from base class
  get label_(): string {
    return 'blaze.LLMStream';
  }
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
    if (opts.authToken !== undefined) this.#opts.authToken = opts.authToken;
    if (opts.deepSearch !== undefined) this.#opts.deepSearch = opts.deepSearch;
    if (opts.agenticSearch !== undefined) this.#opts.agenticSearch = opts.agenticSearch;
    if (opts.enableTools !== undefined) this.#opts.enableTools = opts.enableTools;
    if (opts.demographics !== undefined) this.#opts.demographics = opts.demographics;
    if (opts.timeout !== undefined) this.#opts.timeout = opts.timeout;
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
      snapshotLLMOptions(this.#opts),
      chatCtx,
      connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    );
  }
}

// Export with conventional names
export { BlazeLLM as LLM, BlazeLLMStream as LLMStream };
