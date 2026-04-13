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

// ============================================================================
// Internal: ResponsesWebSocket
//
// Wraps a single raw WebSocket connection.  Maintains a FIFO queue of
// StreamChannels — one per outstanding response.create request — and
// dispatches every incoming server-event to the front of the queue.
// A response is terminated (and its channel closed) when the service sends
// response.completed, response.failed, or error.
//
// ============================================================================

export class ResponsesWebSocket {
  #ws: WebSocket;
  // FIFO queue: the front entry receives validated WsServerEvents for the in-flight response.
  #outputQueue: stream.StreamChannel<WsServerEvent>[] = [];

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
      void current.write(event);

      // Close and dequeue on any terminal event.
      if (
        event.type === 'response.completed' ||
        event.type === 'response.failed' ||
        event.type === 'error'
      ) {
        void current.close();
        this.#outputQueue.shift();
      }
    });

    ws.on('close', () => {
      // If the WebSocket closes while requests are still in flight, synthesise
      // a typed error event so all readers can handle it cleanly.
      for (const current of this.#outputQueue) {
        if (!current.closed) {
          const closeError: WsServerEvent = {
            type: 'error',
            error: {
              code: 'websocket_closed',
              message: 'OpenAI Responses WebSocket closed unexpectedly',
            },
          };
          void current.write(closeError).finally(() => current.close());
        }
      }
      this.#outputQueue = [];
    });
  }

  /**
   * Send a response.create event.  Returns a typed `StreamChannel<WsServerEvent>`
   * that yields validated server events until the response terminates.
   */
  sendRequest(payload: WsResponseCreateEvent): stream.StreamChannel<WsServerEvent> {
    if (this.#ws.readyState !== WebSocket.OPEN) {
      throw new APIConnectionError({
        message: `OpenAI Responses WebSocket is not open (state ${getWebSocketStateLabel(this.#ws.readyState)})`,
        options: { retryable: true },
      });
    }

    const channel = stream.createStreamChannel<WsServerEvent>();
    this.#outputQueue.push(channel);
    this.#ws.send(JSON.stringify(payload));
    return channel;
  }

  close(): void {
    // Drain pending channels before closing the socket.
    for (const ch of this.#outputQueue) {
      void ch.close();
    }
    this.#outputQueue = [];
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
}

const defaultLLMOptions: WSLLMOptions = {
  model: 'gpt-4.1',
  apiKey: process.env.OPENAI_API_KEY,
  strictToolSchema: true,
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
        const wsUrl = this.#opts.baseURL
          ? `${this.#opts.baseURL.replace(/^https?/, 'wss').replace(/\/+$/, '')}/responses`
          : OPENAI_RESPONSES_WS_URL;
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

    let inputChatCtx = chatCtx;
    let prevResponseId: string | undefined;
    const canUseStoredResponse = modelOptions.store !== false;

    if (canUseStoredResponse && this.#prevChatCtx && this.#prevResponseId) {
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
      ? Object.entries(this.toolCtx).map(([name, func]) => {
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
      channel = conn.sendRequest(payload);
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
