// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, llm, log } from '@livekit/agents';
import type {
  ChatTool,
  ChatToolChoice,
  PipelineConstraints,
  Speko,
  ChatMessage as SpekoChatMessage,
} from '@spekoai/sdk';
import { type SpekoClientOptions, createSpekoClient } from './client.js';
import { type Intent, validateIntent } from './intent.js';

/**
 * Error thrown by the Speko plugin when a provider or configuration failure is
 * surfaced through the LiveKit model interface.
 *
 * @public
 */
export class SpekoPluginError extends Error {
  /** Machine-readable Speko plugin error code. */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SpekoPluginError';
    this.code = code;
  }
}

/**
 * Options for the Speko LLM component.
 *
 * @public
 */
export interface LLMOptions extends SpekoClientOptions {
  /** Routing intent sent with every completion request. */
  intent: Intent;
  /** Forwarded to the proxy; defaults to the upstream model's default. */
  temperature?: number;
  /** Forwarded to the proxy; defaults to the upstream model's default. */
  maxTokens?: number;
  /** Optional allow-list constraints. */
  constraints?: PipelineConstraints;
}

/**
 * LiveKit Agents LLM plugin that delegates completion to the Speko proxy
 * (`POST /v1/complete`). The router picks the best LLM provider per intent
 * and fails over automatically.
 *
 * Each `.chat()` call streams text deltas as the proxy emits them, and yields
 * tool calls at the end when the model invokes tools.
 *
 * @public
 */
export class LLM extends llm.LLM {
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #temperature?: number;
  readonly #maxTokens?: number;
  readonly #constraints: PipelineConstraints | undefined;

  constructor(options: LLMOptions) {
    super();
    validateIntent(options.intent);
    this.#speko = createSpekoClient(options);
    this.#intent = options.intent;
    this.#temperature = options.temperature;
    this.#maxTokens = options.maxTokens;
    this.#constraints = options.constraints;
  }

  /** Human-readable model label used by LiveKit metrics and logs. */
  override label(): string {
    return 'speko.LLM';
  }

  /** Provider identifier reported to LiveKit metrics. */
  override get provider(): string {
    return 'speko';
  }

  /** Model identifier reported to LiveKit metrics. */
  override get model(): string {
    return 'speko-router';
  }

  /**
   * Create a LiveKit LLM stream for the provided chat context and runtime
   * tools.
   */
  override chat(params: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new LLMStream(this, {
      chatCtx: params.chatCtx,
      toolCtx: params.toolCtx,
      toolChoice: params.toolChoice,
      parallelToolCalls: params.parallelToolCalls,
      connOptions: params.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      speko: this.#speko,
      intent: this.#intent,
      temperature: this.#temperature,
      maxTokens: this.#maxTokens,
      constraints: this.#constraints,
    });
  }
}

interface LLMStreamArgs {
  chatCtx: llm.ChatContext;
  toolCtx?: llm.ToolContext;
  toolChoice?: llm.ToolChoice;
  parallelToolCalls?: boolean;
  connOptions: APIConnectOptions;
  speko: Speko;
  intent: Intent;
  temperature?: number;
  maxTokens?: number;
  constraints?: PipelineConstraints;
}

class LLMStream extends llm.LLMStream {
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #temperature?: number;
  readonly #maxTokens?: number;
  readonly #constraints: PipelineConstraints | undefined;
  readonly #toolChoice: llm.ToolChoice | undefined;
  readonly #parallelToolCalls: boolean | undefined;

  constructor(parent: LLM, args: LLMStreamArgs) {
    super(parent, {
      chatCtx: args.chatCtx,
      toolCtx: args.toolCtx,
      connOptions: args.connOptions,
    });
    this.#speko = args.speko;
    this.#intent = args.intent;
    this.#temperature = args.temperature;
    this.#maxTokens = args.maxTokens;
    this.#constraints = args.constraints;
    this.#toolChoice = args.toolChoice;
    this.#parallelToolCalls = args.parallelToolCalls;
  }

  protected async run(): Promise<void> {
    // Diagnostic logging mirrors speko.TTS: the LiveKit framework consumes
    // an LLMStream silently if `run()` returns without ever calling
    // `queue.put()`, so without these logs the symptom is a session that
    // emits "Creating speech handle" and then nothing - no error, no audio.
    // Grep the worker container for `[speko.LLM]` to see the per-turn timeline.
    const logger = log();
    const requestId = crypto.randomUUID();
    const t0 = Date.now();

    const messages = chatContextToSpeko(this.chatCtx);
    if (messages.length === 0) {
      logger.error(
        { requestId, chatCtxItems: this.chatCtx.items.length },
        '[speko.LLM] complete:invalid-context',
      );
      throw new SpekoPluginError(
        'speko.LLM: ChatContext produced no convertible messages',
        'INVALID_CONTEXT',
      );
    }

    const tools = toolCtxToSpekoTools(this.toolCtx);

    logger.info(
      {
        requestId,
        messageCount: messages.length,
        lastRole: messages[messages.length - 1]?.role,
        language: this.#intent.language,
        optimizeFor: this.#intent.optimizeFor,
        constraints: this.#constraints,
        toolCount: tools?.length ?? 0,
      },
      '[speko.LLM] complete:start',
    );

    const completeParams = {
      messages,
      intent: {
        language: this.#intent.language,
        ...(this.#intent.region !== undefined && { region: this.#intent.region }),
        ...(this.#intent.optimizeFor !== undefined && {
          optimizeFor: this.#intent.optimizeFor,
        }),
      },
      ...(this.#temperature !== undefined && { temperature: this.#temperature }),
      ...(this.#maxTokens !== undefined && { maxTokens: this.#maxTokens }),
      ...(this.#constraints !== undefined && { constraints: this.#constraints }),
      ...(tools !== undefined && { tools }),
      ...(this.#toolChoice !== undefined && {
        toolChoice: this.#toolChoice as ChatToolChoice,
      }),
      ...(this.#parallelToolCalls !== undefined && {
        parallelToolCalls: this.#parallelToolCalls,
      }),
    };

    let done:
      | {
          text: string;
          provider: string;
          model: string;
          usage: { promptTokens: number; completionTokens: number };
          failoverCount: number;
          toolCalls?: Array<{ id: string; name: string; args: string }>;
        }
      | undefined;
    let streamedTextLength = 0;
    try {
      for await (const event of this.#speko.completeStream(
        completeParams,
        this.abortController.signal,
      )) {
        if (event.type === 'delta') {
          streamedTextLength += event.text.length;
          this.queue.put({
            id: crypto.randomUUID(),
            delta: {
              role: 'assistant',
              content: event.text,
            },
          });
        } else if (event.type === 'done') {
          done = event;
        } else if (event.type === 'error') {
          throw new SpekoPluginError(event.error, event.code);
        }
      }
    } catch (err) {
      // VAD-triggered abort is normal mid-utterance: the framework calls
      // `abortController.abort()` when it detects new user speech, which
      // cancels the in-flight /v1/complete request. Returning cleanly
      // lets the session continue with the next turn. Without this catch,
      // the AbortError propagates as a fatal `llm_error` and the entire
      // AgentSession closes.
      if (this.abortController.signal.aborted) {
        logger.info({ requestId, elapsedMs: Date.now() - t0 }, '[speko.LLM] complete:aborted');
        return;
      }
      logger.error(
        {
          requestId,
          elapsedMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        },
        '[speko.LLM] complete:error',
      );
      throw err;
    }

    if (!done) {
      throw new SpekoPluginError(
        'speko.LLM: complete stream ended without a done event',
        'STREAM_ENDED',
      );
    }

    const toolCalls =
      done.toolCalls && done.toolCalls.length > 0
        ? done.toolCalls.map((tc) =>
            llm.FunctionCall.create({ callId: tc.id, name: tc.name, args: tc.args }),
          )
        : undefined;

    logger.info(
      {
        requestId,
        elapsedMs: Date.now() - t0,
        provider: done.provider,
        model: done.model,
        textLength: done.text?.length ?? 0,
        streamedTextLength,
        toolCallCount: toolCalls?.length ?? 0,
        failoverCount: done.failoverCount,
        promptTokens: done.usage.promptTokens,
        completionTokens: done.usage.completionTokens,
      },
      '[speko.LLM] complete:response',
    );

    // Empty completion (no text AND no tool calls) is a router-side fault
    // we don't want to swallow. Without this check the framework consumes
    // a content-less assistant delta, never invokes TTS, and the session
    // appears frozen with no error. Throwing here surfaces the failure to
    // the AgentSession's Error handler so it's visible in worker logs.
    const hasText = typeof done.text === 'string' && done.text.length > 0;
    if (!hasText && toolCalls === undefined) {
      logger.error(
        {
          requestId,
          elapsedMs: Date.now() - t0,
          provider: done.provider,
          model: done.model,
        },
        '[speko.LLM] complete:empty-result',
      );
      throw new SpekoPluginError(
        `speko.LLM: ${done.provider}/${done.model} returned no text and no tool calls`,
        'EMPTY_COMPLETION',
      );
    }

    if (toolCalls !== undefined) {
      this.queue.put({
        id: crypto.randomUUID(),
        delta: {
          role: 'assistant',
          toolCalls,
        },
      });
    }

    this.queue.put({
      id: crypto.randomUUID(),
      delta: {
        role: 'assistant',
      },
      usage: {
        promptTokens: done.usage.promptTokens,
        completionTokens: done.usage.completionTokens,
        promptCachedTokens: 0,
        totalTokens: done.usage.promptTokens + done.usage.completionTokens,
      },
    });

    logger.info(
      {
        requestId,
        contentLength: hasText ? done.text.length : 0,
        toolCallCount: toolCalls?.length ?? 0,
      },
      '[speko.LLM] queue:put',
    );
  }
}

/**
 * Convert a LiveKit `ToolContext` into the SDK's `ChatTool[]` shape. Returns
 * `undefined` when there are no tools so the proxy receives a clean payload.
 * Schemas are emitted as legacy (non-strict) JSON Schema; the proxy applies
 * provider-specific strict-mode adjustments.
 */
function toolCtxToSpekoTools(toolCtx: llm.ToolContext | undefined): ChatTool[] | undefined {
  if (!toolCtx) return undefined;
  const entries = Object.entries(toolCtx);
  if (entries.length === 0) return undefined;

  const tools: ChatTool[] = [];
  for (const [name, fn] of entries) {
    if (!llm.isFunctionTool(fn)) continue;
    tools.push({
      name,
      description: fn.description,
      parameters: llm.toJsonSchema(fn.parameters, false, false) as Record<string, unknown>,
    });
  }
  return tools.length > 0 ? tools : undefined;
}

/**
 * Flatten a LiveKit `ChatContext` into Speko's `messages` array. System and
 * developer items are emitted inline as `role: 'system'`. `FunctionCall`
 * items become assistant messages with `toolCalls`; `FunctionCallOutput`
 * items become `role: 'tool'` messages with `toolCallId`. Handoff items are
 * skipped. Ordering is preserved.
 *
 * @public
 */
export function chatContextToSpeko(ctx: llm.ChatContext): SpekoChatMessage[] {
  const messages: SpekoChatMessage[] = [];

  for (const item of ctx.items) {
    if (item instanceof llm.ChatMessage) {
      const text = extractText(item);
      if (!text) continue;

      const role =
        item.role === 'developer'
          ? 'system'
          : item.role === 'system' || item.role === 'user' || item.role === 'assistant'
            ? item.role
            : undefined;
      if (role === undefined) continue;

      messages.push({ role, content: text });
      continue;
    }

    if (item instanceof llm.FunctionCall) {
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: item.callId, name: item.name, args: item.args }],
      });
      continue;
    }

    if (item instanceof llm.FunctionCallOutput) {
      messages.push({
        role: 'tool',
        content: item.output,
        toolCallId: item.callId,
        ...(item.isError && { isError: true }),
      });
    }
  }

  return messages;
}

function extractText(message: llm.ChatMessage): string {
  const text = message.textContent;
  return typeof text === 'string' ? text : '';
}
