// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  ConnectionPool,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  stream,
  toError,
} from '@livekit/agents';
import type OpenAI from 'openai';
import { WebSocket } from 'ws';
import type { ChatModels } from '../models.js';
import type {
  WsOutputItemDoneEvent,
  WsOutputTextDeltaEvent,
  WsResponseCompletedEvent,
  WsResponseCreateEvent,
  WsResponseCreatedEvent,
  WsResponseFailedEvent,
  WsServerEvent,
} from './types.js';
import { wsServerEventSchema } from './types.js';

const OPENAI_RESPONSES_WS_URL = 'wss://api.openai.com/v1/responses';

// OpenAI enforces a 60-minute maximum duration on Responses WebSocket connections.
const WS_MAX_SESSION_DURATION = 3_600_000;

// Default receive-side deadline: once a `response.create` has been sent, abort the
// wait if no server event arrives within this window (and, thereafter, if the gap
// between two consecutive events exceeds it). Healthy first-event latency is ~1s in
// production, so 15s is comfortably above the happy path while still bounding the
// pathological "socket stays open, zero events" hang.
const DEFAULT_WS_RESPONSE_TIMEOUT = 15_000;

/**
 * Build the Responses-API WebSocket URL.
 *
 * Includes the model on the upgrade URL so OpenAI-compatible gateways
 * (which can only see the URL at the WebSocket upgrade, not the subsequent
 * `response.create` frame) can route by model. Mirrors the existing
 * convention in `realtime/realtime_model.ts` for the conversational
 * Realtime API. OpenAI's native endpoint accepts and ignores the
 * parameter, so this is a no-op for direct connections.
 *
 * The scheme of `baseURL` is respected: `http://` maps to `ws://`
 * and `https://` maps to `wss://`.
 *
 * @internal
 */
export function buildResponsesWsUrl(baseURL: string | undefined, model: string): string {
  const base = baseURL
    ? `${baseURL.replace(/^http(s?):/, 'ws$1:').replace(/\/+$/, '')}/responses`
    : OPENAI_RESPONSES_WS_URL;
  const url = new URL(base);
  url.searchParams.set('model', model);
  return url.toString();
}

// ============================================================================
// Internal: ResponsesWebSocket
//
// Wraps a single raw WebSocket connection.  Maintains a FIFO queue of
// StreamChannels — one per outstanding response.create request — and
// dispatches every incoming server-event to the front of the queue.
// A response is terminated (and its channel closed) when the service sends
// response.completed, response.failed, or error.
//
// Each queue entry may carry a receive-side deadline (see `sendRequest`): if no
// server event arrives before it fires — the first-event case — or if the gap
// between two consecutive events exceeds it — the inactivity case — the entry's
// channel is aborted with a retryable APIConnectionError and the socket is torn
// down so the next turn reconnects. This guards against the service (or an
// intermediary gateway) leaving the socket open and silent after a
// `response.create`, which would otherwise block the reader forever.
//
// ============================================================================

interface OutputQueueEntry {
  channel: stream.StreamChannel<WsServerEvent>;
  /** Idle/first-event deadline in ms; a non-positive value disables the timer. */
  timeoutMs?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class ResponsesWebSocket {
  #ws: WebSocket;
  // FIFO queue: the front entry receives validated WsServerEvents for the in-flight response.
  #outputQueue: OutputQueueEntry[] = [];

  constructor(ws: WebSocket) {
    this.#ws = ws;

    ws.on('message', (data: Buffer) => {
      const current = this.#outputQueue[0];
      if (!current) return;

      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Validate and type-narrow with Zod at write time so readers always
      // receive a fully-typed WsServerEvent.
      const parsed = wsServerEventSchema.safeParse(raw);
      if (!parsed.success) return;

      const event = parsed.data;
      void current.channel.write(event);

      // Close and dequeue on any terminal event; otherwise reset the idle
      // deadline now that we have proof the connection is still producing.
      if (
        event.type === 'response.completed' ||
        event.type === 'response.failed' ||
        event.type === 'error'
      ) {
        this.#clearTimer(current);
        void current.channel.close();
        this.#outputQueue.shift();
      } else {
        this.#armTimer(current);
      }
    });

    ws.on('close', () => {
      // If the WebSocket closes while requests are still in flight, synthesise
      // a typed error event so all readers can handle it cleanly.
      for (const current of this.#outputQueue) {
        this.#clearTimer(current);
        if (!current.channel.closed) {
          const closeError: WsServerEvent = {
            type: 'error',
            error: {
              code: 'websocket_closed',
              message: 'OpenAI Responses WebSocket closed unexpectedly',
            },
          };
          void current.channel.write(closeError).finally(() => current.channel.close());
        }
      }
      this.#outputQueue = [];
    });
  }

  /**
   * Send a response.create event.  Returns a typed `StreamChannel<WsServerEvent>`
   * that yields validated server events until the response terminates.
   *
   * @param timeoutMs - Receive-side deadline. When set to a positive value, the
   *   returned channel is aborted with a retryable {@link APIConnectionError} if the
   *   server sends no event within `timeoutMs` of the request (first-event
   *   deadline) or between any two consecutive events (inactivity deadline),
   *   and the underlying socket is closed. This is distinct from the
   *   connection-establishment timeout used in `connectWs`.
   */
  sendRequest(
    payload: WsResponseCreateEvent,
    timeoutMs?: number,
  ): stream.StreamChannel<WsServerEvent> {
    if (this.#ws.readyState !== WebSocket.OPEN) {
      throw new APIConnectionError({
        message: `OpenAI Responses WebSocket is not open (state ${getWebSocketStateLabel(this.#ws.readyState)})`,
        options: { retryable: true },
      });
    }

    const channel = stream.createStreamChannel<WsServerEvent>();
    const entry: OutputQueueEntry = { channel, timeoutMs };
    this.#outputQueue.push(entry);
    // Arm the first-event deadline before sending so a completely silent
    // response is still bounded.
    this.#armTimer(entry);
    this.#ws.send(JSON.stringify(payload));
    return channel;
  }

  close(): void {
    // Drain pending channels before closing the socket.
    for (const entry of this.#outputQueue) {
      this.#clearTimer(entry);
      void entry.channel.close();
    }
    this.#outputQueue = [];
    this.#ws.close();
  }

  #armTimer(entry: OutputQueueEntry): void {
    if (entry.timeoutMs === undefined || entry.timeoutMs <= 0) return;
    this.#clearTimer(entry);
    entry.timer = setTimeout(() => this.#onRequestTimeout(entry), entry.timeoutMs);
  }

  #clearTimer(entry: OutputQueueEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  #onRequestTimeout(entry: OutputQueueEntry): void {
    const idx = this.#outputQueue.indexOf(entry);
    // Already resolved (terminal event or socket close won the race).
    if (idx === -1) return;

    // Remove the dead entry so a later, healthy turn reusing this connection
    // (were it not torn down below) can't be misrouted to it.
    this.#outputQueue.splice(idx, 1);
    this.#clearTimer(entry);

    void entry.channel.abort(
      new APIConnectionError({
        message: `OpenAI Responses WebSocket received no event within ${entry.timeoutMs}ms`,
        options: { retryable: true },
      }),
    );

    // A socket that accepted the request but went silent can't be trusted for
    // reuse — close it so the pool opens a fresh connection on the next turn.
    this.#ws.close();
  }
}

// ============================================================================
// LLMOptions
// ============================================================================

export interface WSLLMOptions {
  model: string | ChatModels;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  parallelToolCalls?: boolean;
  toolChoice?: llm.ToolChoice;
  store?: boolean;
  metadata?: Record<string, string>;
  strictToolSchema?: boolean;
  /** Specifies the processing tier (e.g. 'auto', 'default', 'priority', 'flex'). */
  serviceTier?: string;
  /** Upper bound for the number of tokens that can be generated for a response. */
  maxOutputTokens?: number;
  /**
   * Receive-side deadline in milliseconds for the persistent Responses
   * WebSocket. After a `response.create` is sent, the turn is aborted (with a
   * retryable error that triggers reconnect + retry) if the server sends no
   * event within this window, or if the gap between two consecutive events
   * exceeds it. Guards against the socket staying open but silent, which would
   * otherwise hang the turn indefinitely. Set to `0` (or a negative value) to
   * disable. Distinct from the connection-establishment timeout.
   *
   * @defaultValue 15000
   */
  responseTimeoutMs?: number;
}

const defaultLLMOptions: WSLLMOptions = {
  model: 'gpt-4.1',
  apiKey: process.env.OPENAI_API_KEY,
  strictToolSchema: true,
  responseTimeoutMs: DEFAULT_WS_RESPONSE_TIMEOUT,
};

// ============================================================================
// LLM
// ============================================================================

export class WSLLM extends llm.LLM {
  #opts: WSLLMOptions;
  #pool: ConnectionPool<ResponsesWebSocket>;
  #prevResponseId = '';
  #prevChatCtx: llm.ChatContext | null = null;
  #pendingToolCalls = new Set<string>();
  // Number of in-flight WSLLMStream generations, and whether any two ever
  // overlapped. The stored previous_response_id / chat-ctx continuation chain
  // assumes strictly serial turns; concurrent generations can interleave and
  // corrupt it, so we only take the continuation shortcut when idle and reset
  // the stored state once all overlapping generations have drained.
  #activeStreams = 0;
  #parallelGeneration = false;

  /**
   * Create a new instance of the OpenAI Responses API WebSocket LLM.
   *
   * @remarks
   * `apiKey` must be set to your OpenAI API key, either using the argument or
   * by setting the `OPENAI_API_KEY` environment variable.
   *
   * A persistent WebSocket connection to `/v1/responses` is maintained and
   * reused across turns, reducing per-turn continuation overhead for
   * tool-call-heavy workflows.
   */
  constructor(opts: Partial<WSLLMOptions> = defaultLLMOptions) {
    super();

    this.#opts = { ...defaultLLMOptions, ...opts };
    if (!this.#opts.apiKey) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    this.#pool = new ConnectionPool<ResponsesWebSocket>({
      maxSessionDuration: WS_MAX_SESSION_DURATION,
      connectCb: async (timeoutMs: number) => {
        const wsUrl = buildResponsesWsUrl(this.#opts.baseURL, String(this.#opts.model));
        const ws = await connectWs(wsUrl, this.#opts.apiKey!, timeoutMs);
        return new ResponsesWebSocket(ws);
      },
      closeCb: async (conn: ResponsesWebSocket) => {
        conn.close();
      },
    });
  }

  label(): string {
    return 'openai.ws.LLM';
  }

  get model(): string {
    return this.#opts.model;
  }

  prewarm(): void {
    this.#pool.prewarm();
  }

  async close(): Promise<void> {
    await this.#pool.close();
  }

  override async aclose(): Promise<void> {
    await this.close();
  }

  /** Called by LLMStream once response.created fires to atomically persist both the
   *  response ID and its corresponding chat context for the next turn's diff. */
  _onResponseCreated(responseId: string, chatCtx: llm.ChatContext): void {
    this.#prevResponseId = responseId;
    this.#prevChatCtx = chatCtx;
  }

  _setPendingToolCalls(callIds: Set<string>): void {
    this.#pendingToolCalls = callIds;
  }

  /** Called by WSLLMStream when a generation begins. Tracks overlap so the
   *  continuation chain can be invalidated if turns run concurrently. */
  _onStreamStarted(): void {
    if (this.#activeStreams > 0) {
      this.#parallelGeneration = true;
    }
    this.#activeStreams += 1;
  }

  /** Called by WSLLMStream when a generation ends (success or failure). Once all
   *  overlapping generations have drained, drop the stored continuation state so
   *  the next turn re-sends the full context instead of chaining off a
   *  potentially corrupted previous_response_id. */
  _onStreamFinished(): void {
    this.#activeStreams -= 1;
    if (this.#activeStreams === 0 && this.#parallelGeneration) {
      this.#prevResponseId = '';
      this.#prevChatCtx = null;
      this.#parallelGeneration = false;
    }
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
  }): WSLLMStream {
    const modelOptions: Record<string, unknown> = { ...(extraKwargs ?? {}) };

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

    if (this.#opts.serviceTier) {
      modelOptions.service_tier = this.#opts.serviceTier;
    }

    if (this.#opts.maxOutputTokens !== undefined) {
      modelOptions.max_output_tokens = this.#opts.maxOutputTokens;
    }

    let inputChatCtx = chatCtx;
    let prevResponseId: string | undefined;
    const canUseStoredResponse = modelOptions.store !== false;

    // Only continue from a stored previous_response_id when no other generation
    // is in flight — a concurrent turn may be mutating the continuation chain.
    if (
      canUseStoredResponse &&
      this.#activeStreams === 0 &&
      this.#prevChatCtx &&
      this.#prevResponseId
    ) {
      const diff = llm.computeChatCtxDiff(this.#prevChatCtx, chatCtx);
      const lastPrevItemId = this.#prevChatCtx.items.at(-1)?.id ?? null;

      if (
        diff.toRemove.length === 0 &&
        diff.toCreate.length > 0 &&
        diff.toCreate[0]![0] === lastPrevItemId
      ) {
        // All new items are appended after the tail of the previous context —
        // safe to send only the incremental input with previous_response_id,
        // but only if all pending tool calls from the previous response have
        // their corresponding function_call_output in the new items.
        const newItemIds = new Set(diff.toCreate.map(([, id]) => id));
        const newItems = chatCtx.items.filter((item: llm.ChatItem) => newItemIds.has(item.id));
        const pendingToolCallsCompleted = this.#pendingToolCallsCompleted(newItems);
        if (pendingToolCallsCompleted) {
          inputChatCtx = new llm.ChatContext(newItems);
          prevResponseId = this.#prevResponseId;
        }
      }
      // Otherwise: items were removed or inserted mid-history — fall back to
      // sending the full context with no previous_response_id.
    }

    return new WSLLMStream(this, {
      pool: this.#pool,
      model: this.#opts.model,
      chatCtx: inputChatCtx,
      fullChatCtx: chatCtx,
      toolCtx,
      connOptions,
      modelOptions,
      prevResponseId,
      strictToolSchema: this.#opts.strictToolSchema ?? true,
      responseTimeoutMs: this.#opts.responseTimeoutMs ?? DEFAULT_WS_RESPONSE_TIMEOUT,
    });
  }

  #pendingToolCallsCompleted(items: llm.ChatItem[]): boolean {
    if (this.#pendingToolCalls.size === 0) return true;
    const completedCallIds = new Set(
      items
        .filter((item): item is llm.FunctionCallOutput => item.type === 'function_call_output')
        .map((item) => item.callId),
    );
    return [...this.#pendingToolCalls].every((callId) => completedCallIds.has(callId));
  }
}

// ============================================================================
// WsLLMStream
// ============================================================================

export class WSLLMStream extends llm.LLMStream {
  #llm: WSLLM;
  #pool: ConnectionPool<ResponsesWebSocket>;
  #model: string | ChatModels;
  #modelOptions: Record<string, unknown>;
  #strictToolSchema: boolean;
  #prevResponseId?: string;
  /** Full chat context — used as fallback when previous_response_id is stale. */
  #fullChatCtx: llm.ChatContext;
  #responseId = '';
  #pendingToolCalls = new Set<string>();
  #responseTimeoutMs: number;
  #responseCompleted = false;
  // Balances the _onStreamStarted() reservation made in the constructor. The
  // release must fire exactly once, and only after the stream's *whole* lifetime
  // ends — not per attempt: the base class calls run() once per retry attempt
  // (up to maxRetry+1 times), so releasing in run()'s finally would drop the
  // count after the first attempt and leave the stream uncounted during the
  // retry-delay window, letting a concurrent chat() wrongly reuse the stored
  // previous_response_id. Instead we release from the monitorMetrics() override,
  // which the base runs once and which only returns after mainTask has drained
  // and closed the queue (i.e. after all retries).
  #streamReleased = false;

  constructor(
    llm: WSLLM,
    {
      pool,
      model,
      chatCtx,
      fullChatCtx,
      toolCtx,
      connOptions,
      modelOptions,
      prevResponseId,
      strictToolSchema,
      responseTimeoutMs,
    }: {
      pool: ConnectionPool<ResponsesWebSocket>;
      model: string | ChatModels;
      chatCtx: llm.ChatContext;
      fullChatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      modelOptions: Record<string, unknown>;
      prevResponseId?: string;
      strictToolSchema: boolean;
      responseTimeoutMs: number;
    },
  ) {
    super(llm, { chatCtx, toolCtx, connOptions });
    this.#llm = llm;
    this.#pool = pool;
    this.#model = model;
    this.#modelOptions = modelOptions;
    this.#strictToolSchema = strictToolSchema;
    this.#prevResponseId = prevResponseId;
    this.#fullChatCtx = fullChatCtx;
    this.#responseTimeoutMs = responseTimeoutMs;
    // Reserve synchronously here (the constructor runs inside WSLLM.chat(), after
    // its continuation decision) so a second chat() issued in the same tick
    // observes this generation as in-flight and can't also take the
    // previous_response_id shortcut. Doing this in run() would be too late — run
    // is deferred to a later tick by the LLMStream base constructor.
    this.#llm._onStreamStarted();
  }

  #releaseStream(): void {
    if (this.#streamReleased) return;
    this.#streamReleased = true;
    this.#llm._onStreamFinished();
  }

  /**
   * The base class runs this exactly once per stream and it only returns after
   * `mainTask` has closed the queue — i.e. after every retry attempt has
   * finished. That makes it the correct place to release the parallel-generation
   * reservation taken in the constructor (run()'s finally fires per attempt).
   */
  protected override async monitorMetrics(): Promise<void> {
    try {
      await super.monitorMetrics();
    } finally {
      this.#releaseStream();
    }
  }

  protected async run(): Promise<void> {
    let retryable = true;

    try {
      await this.#pool.withConnection(async (conn: ResponsesWebSocket) => {
        const needsRetry = await this.#runWithConn(conn, this.chatCtx, this.#prevResponseId);

        if (needsRetry) {
          // previous_response_id was evicted from the server-side cache.
          // Retry once on the same connection with the full context and no ID.
          retryable = true;
          await this.#runWithConn(conn, this.#fullChatCtx, undefined);
        }

        // The receive loop drained without a response.completed (e.g. the
        // channel closed after a non-terminal event). Treat as a transient
        // failure so the SDK reconnects and retries rather than silently
        // yielding an empty turn.
        if (!this.#responseCompleted) {
          conn.close();
          this.#pool.invalidate();
          throw new APIConnectionError({
            message: 'OpenAI Responses WebSocket stream ended without a completed response',
            options: { retryable: true },
          });
        }
      });
    } catch (error) {
      if (
        error instanceof APIStatusError ||
        error instanceof APITimeoutError ||
        error instanceof APIConnectionError
      ) {
        throw error;
      }
      throw new APIConnectionError({
        message: toError(error).message,
        options: { retryable },
      });
    }
  }

  /**
   * Execute a single response.create round-trip on the given connection.
   * Returns `true` when the caller should retry with the full chat context
   * (i.e. `previous_response_not_found`), `false` otherwise.
   */
  async #runWithConn(
    conn: ResponsesWebSocket,
    chatCtx: llm.ChatContext,
    prevResponseId: string | undefined,
  ): Promise<boolean> {
    const messages = (await chatCtx.toProviderFormat(
      'openai.responses',
    )) as OpenAI.Responses.ResponseInputItem[];

    const tools = this.toolCtx
      ? llm.sortedToolEntries(this.toolCtx).map(([name, func]) => {
          const oaiParams = {
            type: 'function' as const,
            name,
            description: func.description,
            parameters: llm.toJsonSchema(
              func.parameters,
              true,
              this.#strictToolSchema,
            ) as unknown as OpenAI.Responses.FunctionTool['parameters'],
          } as OpenAI.Responses.FunctionTool;

          if (this.#strictToolSchema) {
            oaiParams.strict = true;
          }

          return oaiParams;
        })
      : undefined;

    const requestOptions: Record<string, unknown> = { ...this.#modelOptions };
    if (!tools) {
      delete requestOptions.tool_choice;
    }

    const payload: WsResponseCreateEvent = {
      type: 'response.create',
      model: this.#model as string,
      input: messages as unknown[],
      tools: (tools ?? []) as unknown[],
      ...(prevResponseId ? { previous_response_id: prevResponseId } : {}),
      ...requestOptions,
    };

    let channel: stream.StreamChannel<WsServerEvent>;
    try {
      channel = conn.sendRequest(payload, this.#responseTimeoutMs);
    } catch (error) {
      if (error instanceof APIConnectionError) {
        conn.close();
        this.#pool.invalidate();
      }
      throw error;
    }
    const reader = channel.stream().getReader();

    // Events are already Zod-validated by ResponsesWebSocket before being
    // written to the channel, so no re-parsing is needed here.
    try {
      while (true) {
        const { done, value: event } = await reader.read();
        if (done) break;

        let chunk: llm.ChatChunk | undefined;

        switch (event.type) {
          case 'error': {
            const retry = this.#handleError(event, conn);
            if (retry) return true;
            break;
          }
          case 'response.created':
            this.#handleResponseCreated(event);
            break;
          case 'response.output_item.done':
            chunk = this.#handleOutputItemDone(event);
            break;
          case 'response.output_text.delta':
            chunk = this.#handleOutputTextDelta(event);
            break;
          case 'response.completed':
            chunk = this.#handleResponseCompleted(event);
            break;
          case 'response.failed':
            this.#handleResponseFailed(event);
            break;
          default:
            break;
        }

        if (chunk) {
          this.queue.put(chunk);
        }
      }
    } finally {
      reader.releaseLock();
    }

    return false;
  }

  /**
   * Returns `true` when the caller should retry with full context
   * (`previous_response_not_found`), throws for all other errors.
   */
  #handleError(event: WsServerEvent & { type: 'error' }, conn: ResponsesWebSocket): boolean {
    const code = event.error?.code;

    if (code === 'previous_response_not_found') {
      // The server-side in-memory cache was evicted (e.g. after a failed turn
      // or reconnect). Signal the caller to retry with the full context.
      return true;
    }

    if (code === 'websocket_connection_limit_reached' || code === 'websocket_closed') {
      // Transient connection issue (timeout, network drop, or 60-min limit).
      // Evict this connection so the pool opens a fresh one on retry.
      conn.close();
      this.#pool.invalidate();
      throw new APIConnectionError({
        message: event.error?.message ?? `WebSocket closed (${code})`,
        options: { retryable: true },
      });
    }

    throw new APIStatusError({
      message: event.error?.message ?? event.message ?? 'Unknown error from OpenAI Responses WS',
      options: {
        statusCode: event.status ?? -1,
        retryable: false,
      },
    });
  }

  #handleResponseCreated(event: WsResponseCreatedEvent): void {
    this.#responseId = event.response.id;
    this.#llm._onResponseCreated(event.response.id, this.#fullChatCtx);
  }

  #handleOutputItemDone(event: WsOutputItemDoneEvent): llm.ChatChunk | undefined {
    if (event.item.type === 'function_call') {
      this.#pendingToolCalls.add(event.item.call_id);
      return {
        id: this.#responseId,
        delta: {
          role: 'assistant',
          content: undefined,
          toolCalls: [
            llm.FunctionCall.create({
              callId: event.item.call_id,
              name: event.item.name,
              args: event.item.arguments,
            }),
          ],
        },
      };
    } else if (event.item.type === 'message' && event.item.phase !== undefined) {
      return {
        id: this.#responseId,
        delta: {
          role: 'assistant',
          content: undefined,
          extra: { openai: { phase: event.item.phase } },
        },
      };
    }
    return undefined;
  }

  #handleOutputTextDelta(event: WsOutputTextDeltaEvent): llm.ChatChunk {
    return {
      id: this.#responseId,
      delta: {
        role: 'assistant',
        content: event.delta,
      },
    };
  }

  #handleResponseCompleted(event: WsResponseCompletedEvent): llm.ChatChunk | undefined {
    this.#responseCompleted = true;
    this.#llm._setPendingToolCalls(this.#pendingToolCalls);

    if (event.response.usage) {
      return {
        id: this.#responseId,
        usage: {
          completionTokens: event.response.usage.output_tokens,
          promptTokens: event.response.usage.input_tokens,
          promptCachedTokens: event.response.usage.input_tokens_details.cached_tokens,
          totalTokens: event.response.usage.total_tokens,
          serviceTier: event.response.service_tier ?? undefined,
        },
      };
    }
    return undefined;
  }

  #handleResponseFailed(event: WsResponseFailedEvent): void {
    throw new APIStatusError({
      message: event.response?.error?.message ?? 'Response failed',
      options: { statusCode: -1, retryable: false },
    });
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

async function connectWs(url: string, apiKey: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      ws.close();
      reject(
        new APIConnectionError({ message: 'Timeout connecting to OpenAI Responses WebSocket' }),
      );
    }, timeoutMs);

    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });

    ws.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new APIConnectionError({
          message: `Error connecting to OpenAI Responses WebSocket: ${err.message}`,
        }),
      );
    });

    ws.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new APIConnectionError({
          message: `OpenAI Responses WebSocket closed unexpectedly during connect (code ${code})`,
        }),
      );
    });
  });
}

function getWebSocketStateLabel(readyState: number): string {
  switch (readyState) {
    case WebSocket.CONNECTING:
      return 'CONNECTING';
    case WebSocket.OPEN:
      return 'OPEN';
    case WebSocket.CLOSING:
      return 'CLOSING';
    case WebSocket.CLOSED:
      return 'CLOSED';
    default:
      return `UNKNOWN:${readyState}`;
  }
}
