// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import type { LLMMetrics } from '../metrics/base.js';
import type { APIConnectOptions } from '../types.js';
import { AsyncIterableQueue, delay, startSoon, toError } from '../utils.js';
import { type ChatContext, type ChatRole, type FunctionCall } from './chat_context.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

export interface ChoiceDelta {
  role: ChatRole;
  content?: string;
  toolCalls?: FunctionCall[];
}

export interface CompletionUsage {
  completionTokens: number;
  promptTokens: number;
  promptCachedTokens: number;
  totalTokens: number;
}

export interface ChatChunk {
  id: string;
  delta?: ChoiceDelta;
  usage?: CompletionUsage;
}

export interface LLMError {
  type: 'llm_error';
  timestamp: number;
  label: string;
  error: Error;
  recoverable: boolean;
}

export type LLMCallbacks = {
  ['metrics_collected']: (metrics: LLMMetrics) => void;
  ['error']: (error: LLMError) => void;
};

export abstract class LLM extends (EventEmitter as new () => TypedEmitter<LLMCallbacks>) {
  constructor() {
    super();
  }

  abstract label(): string;

  /**
   * Get the model name/identifier for this LLM instance.
   *
   * @returns The model name if available, "unknown" otherwise.
   *
   * @remarks
   * Plugins should override this property to provide their model information.
   */
  get model(): string {
    return 'unknown';
  }

  /**
   * Returns a {@link LLMStream} that can be used to push text and receive LLM responses.
   */
  abstract chat({
    chatCtx,
    toolCtx,
    connOptions,
    parallelToolCalls,
    toolChoice,
    extraKwargs,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream;

  /**
   * Pre-warm connection to the LLM service
   */
  prewarm(): void {
    // Default implementation - subclasses can override
  }

  async aclose(): Promise<void> {
    // Default implementation - subclasses can override
  }
}

export abstract class LLMStream implements AsyncIterableIterator<ChatChunk> {
  protected output = new AsyncIterableQueue<ChatChunk>();
  protected queue = new AsyncIterableQueue<ChatChunk>();
  protected closed = false;
  protected abortController = new AbortController();
  protected _connOptions: APIConnectOptions;
  protected logger = log();

  #llm: LLM;
  #chatCtx: ChatContext;
  #toolCtx?: ToolContext;

  constructor(
    llm: LLM,
    {
      chatCtx,
      toolCtx,
      connOptions,
    }: {
      chatCtx: ChatContext;
      toolCtx?: ToolContext;
      connOptions: APIConnectOptions;
    },
  ) {
    this.#llm = llm;
    this.#chatCtx = chatCtx;
    this.#toolCtx = toolCtx;
    this._connOptions = connOptions;
    this.monitorMetrics();
    this.abortController.signal.addEventListener('abort', () => {
      // TODO (AJS-37) clean this up when we refactor with streams
      this.output.close();
      this.closed = true;
    });

    // this is a hack to immitate asyncio.create_task so that mainTask
    // is run **after** the constructor has finished. Otherwise we get
    // runtime error when trying to access class variables in the
    // `run` method.
    startSoon(() => this.mainTask().then(() => this.queue.close()));
  }

  private async mainTask() {
    // TODO(brian): PR3 - Add span wrapping: tracer.startActiveSpan('llm_request', ..., { endOnExit: false })
    for (let i = 0; i < this._connOptions.maxRetry + 1; i++) {
      try {
        // TODO(brian): PR3 - Add span for retry attempts: tracer.startActiveSpan('llm_request_run', ...)
        return await this.run();
      } catch (error) {
        if (error instanceof APIError) {
          const retryInterval = this._connOptions._intervalForRetry(i);

          if (this._connOptions.maxRetry === 0 || !error.retryable) {
            this.emitError({ error, recoverable: false });
            throw error;
          } else if (i === this._connOptions.maxRetry) {
            this.emitError({ error, recoverable: false });
            throw new APIConnectionError({
              message: `failed to generate LLM completion after ${this._connOptions.maxRetry + 1} attempts`,
              options: { retryable: false },
            });
          } else {
            this.emitError({ error, recoverable: true });
            this.logger.warn(
              { llm: this.#llm.label(), attempt: i + 1, error },
              `failed to generate LLM completion, retrying in ${retryInterval}s`,
            );
          }

          if (retryInterval > 0) {
            await delay(retryInterval);
          }
        } else {
          this.emitError({ error: toError(error), recoverable: false });
          throw error;
        }
      }
    }
  }

  private emitError({ error, recoverable }: { error: Error; recoverable: boolean }) {
    this.#llm.emit('error', {
      type: 'llm_error',
      timestamp: Date.now(),
      label: this.#llm.label(),
      error,
      recoverable,
    });
  }

  protected async monitorMetrics() {
    const startTime = process.hrtime.bigint();
    let ttft: bigint = BigInt(-1);
    let requestId = '';
    let usage: CompletionUsage | undefined;

    for await (const ev of this.queue) {
      if (this.abortController.signal.aborted) {
        break;
      }
      this.output.put(ev);
      requestId = ev.id;
      if (ttft === BigInt(-1)) {
        ttft = process.hrtime.bigint() - startTime;
      }
      if (ev.usage) {
        usage = ev.usage;
      }
    }
    this.output.close();

    const duration = process.hrtime.bigint() - startTime;
    const durationMs = Math.trunc(Number(duration / BigInt(1000000)));
    const metrics: LLMMetrics = {
      type: 'llm_metrics',
      timestamp: Date.now(),
      requestId,
      ttftMs: ttft === BigInt(-1) ? -1 : Math.trunc(Number(ttft / BigInt(1000000))),
      durationMs,
      cancelled: this.abortController.signal.aborted,
      label: this.#llm.label(),
      completionTokens: usage?.completionTokens || 0,
      promptTokens: usage?.promptTokens || 0,
      promptCachedTokens: usage?.promptCachedTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      tokensPerSecond: (() => {
        if (durationMs <= 0) {
          return 0;
        }
        return (usage?.completionTokens || 0) / (durationMs / 1000);
      })(),
    };
    this.#llm.emit('metrics_collected', metrics);
  }

  protected abstract run(): Promise<void>;

  /** The function context of this stream. */
  get toolCtx(): ToolContext | undefined {
    return this.#toolCtx;
  }

  /** The initial chat context of this stream. */
  get chatCtx(): ChatContext {
    return this.#chatCtx;
  }

  /** The connection options for this stream. */
  get connOptions(): APIConnectOptions {
    return this._connOptions;
  }

  next(): Promise<IteratorResult<ChatChunk>> {
    return this.output.next();
  }

  close() {
    this.abortController.abort();
  }

  [Symbol.asyncIterator](): LLMStream {
    return this;
  }
}
