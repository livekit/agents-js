// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import type { ChatContext } from './chat_context.js';
import type { ChatChunk } from './llm.js';
import { LLM, LLMStream } from './llm.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

/**
 * Default connection options for FallbackAdapter.
 * Uses max_retry=0 since fallback handles retries at a higher level.
 */
const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

/**
 * Internal status tracking for each LLM instance.
 */
interface LLMStatus {
  available: boolean;
  recoveringTask: Promise<void> | null;
}

/**
 * Event emitted when an LLM's availability changes.
 */
export interface AvailabilityChangedEvent {
  llm: LLM;
  available: boolean;
}

/**
 * Options for creating a FallbackAdapter.
 */
export interface FallbackAdapterOptions {
  /** List of LLM instances to fallback to (in order). */
  llms: LLM[];
  /** Timeout for each LLM attempt in seconds. Defaults to 5.0. */
  attemptTimeout?: number;
  /** Internal retries per LLM before moving to next. Defaults to 0. */
  maxRetryPerLLM?: number;
  /** Interval between retries in seconds. Defaults to 0.5. */
  retryInterval?: number;
  /** Whether to retry when LLM fails after chunks are sent. Defaults to false. */
  retryOnChunkSent?: boolean;
}

/**
 * FallbackAdapter is an LLM that can fallback to a different LLM if the current LLM fails.
 *
 * @example
 * ```typescript
 * const fallbackLLM = new FallbackAdapter({
 *   llms: [primaryLLM, secondaryLLM, tertiaryLLM],
 *   attemptTimeout: 5.0,
 *   maxRetryPerLLM: 1,
 * });
 * ```
 */
export class FallbackAdapter extends LLM {
  readonly llms: LLM[];
  readonly attemptTimeout: number;
  readonly maxRetryPerLLM: number;
  readonly retryInterval: number;
  readonly retryOnChunkSent: boolean;

  /** @internal */
  _status: LLMStatus[];

  private logger = log();

  constructor(options: FallbackAdapterOptions) {
    super();

    if (!options.llms || options.llms.length < 1) {
      throw new Error('at least one LLM instance must be provided.');
    }

    this.llms = options.llms;
    this.attemptTimeout = options.attemptTimeout ?? 5.0;
    this.maxRetryPerLLM = options.maxRetryPerLLM ?? 0;
    this.retryInterval = options.retryInterval ?? 0.5;
    this.retryOnChunkSent = options.retryOnChunkSent ?? false;

    // Initialize status for each LLM
    this._status = this.llms.map(() => ({
      available: true,
      recoveringTask: null,
    }));

    // Forward metrics_collected events from child LLMs
    for (const llm of this.llms) {
      llm.on('metrics_collected', (metrics) => {
        this.emit('metrics_collected', metrics);
      });
    }
  }

  get model(): string {
    return 'FallbackAdapter';
  }

  label(): string {
    return 'FallbackAdapter';
  }

  chat(opts: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    return new FallbackLLMStream(this, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions || DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
      parallelToolCalls: opts.parallelToolCalls,
      toolChoice: opts.toolChoice,
      extraKwargs: opts.extraKwargs,
    });
  }

  /**
   * Emit availability changed event.
   * @internal
   */
  _emitAvailabilityChanged(llm: LLM, available: boolean): void {
    const event: AvailabilityChangedEvent = { llm, available };
    // Use type assertion for custom event
    (this as unknown as { emit: (event: string, data: AvailabilityChangedEvent) => void }).emit(
      'llm_availability_changed',
      event,
    );
  }
}

/**
 * LLMStream implementation for FallbackAdapter.
 * Handles fallback logic between multiple LLM providers.
 */
class FallbackLLMStream extends LLMStream {
  private adapter: FallbackAdapter;
  private parallelToolCalls?: boolean;
  private toolChoice?: ToolChoice;
  private extraKwargs?: Record<string, unknown>;
  private _currentStream?: LLMStream;
  private _log = log();

  constructor(
    adapter: FallbackAdapter,
    opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolContext;
      connOptions: APIConnectOptions;
      parallelToolCalls?: boolean;
      toolChoice?: ToolChoice;
      extraKwargs?: Record<string, unknown>;
    },
  ) {
    super(adapter, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions,
    });
    this.adapter = adapter;
    this.parallelToolCalls = opts.parallelToolCalls;
    this.toolChoice = opts.toolChoice;
    this.extraKwargs = opts.extraKwargs;
  }

  /**
   * Override chatCtx to return current stream's context if available.
   */
  override get chatCtx(): ChatContext {
    return this._currentStream?.chatCtx ?? super.chatCtx;
  }

  /**
   * Try to generate with a single LLM.
   * Returns an async generator that yields chunks.
   */
  private async *tryGenerate(
    llm: LLM,
    checkRecovery: boolean = false,
  ): AsyncGenerator<ChatChunk, void, unknown> {
    const connOptions: APIConnectOptions = {
      ...this.connOptions,
      maxRetry: this.adapter.maxRetryPerLLM,
      timeoutMs: this.adapter.attemptTimeout * 1000,
      retryIntervalMs: this.adapter.retryInterval * 1000,
    };

    const stream = llm.chat({
      chatCtx: super.chatCtx,
      toolCtx: this.toolCtx,
      connOptions,
      parallelToolCalls: this.parallelToolCalls,
      toolChoice: this.toolChoice,
      extraKwargs: this.extraKwargs,
    });

    // Listen for error events - child LLMs emit errors via their LLM instance, not the stream
    let streamError: Error | undefined;
    const errorHandler = (ev: { error: Error }) => {
      streamError = ev.error;
    };
    llm.on('error', errorHandler);

    try {
      let shouldSetCurrent = !checkRecovery;
      for await (const chunk of stream) {
        if (shouldSetCurrent) {
          shouldSetCurrent = false;
          this._currentStream = stream;
        }
        yield chunk;
      }

      // If an error was emitted but not thrown through iteration, throw it now
      if (streamError) {
        throw streamError;
      }
    } catch (error) {
      if (error instanceof APIError) {
        if (checkRecovery) {
          this._log.warn({ llm: llm.label(), error }, 'recovery failed');
        } else {
          this._log.warn({ llm: llm.label(), error }, 'failed, switching to next LLM');
        }
        throw error;
      }

      // Handle timeout errors
      if (error instanceof Error && error.name === 'AbortError') {
        if (checkRecovery) {
          this._log.warn({ llm: llm.label() }, 'recovery timed out');
        } else {
          this._log.warn({ llm: llm.label() }, 'timed out, switching to next LLM');
        }
        throw error;
      }

      // Unexpected error
      if (checkRecovery) {
        this._log.error({ llm: llm.label(), error }, 'recovery unexpected error');
      } else {
        this._log.error({ llm: llm.label(), error }, 'unexpected error, switching to next LLM');
      }
      throw error;
    } finally {
      llm.off('error', errorHandler);
    }
  }

  /**
   * Start background recovery task for an LLM.
   */
  private tryRecovery(llm: LLM, index: number): void {
    const status = this.adapter._status[index]!;

    // Skip if already recovering
    if (status.recoveringTask !== null) {
      return;
    }

    const recoverTask = async (): Promise<void> => {
      try {
        // Try to generate (just iterate to check if it works)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of this.tryGenerate(llm, true)) {
          // Just consume the stream to verify it works
        }

        // Recovery successful
        status.available = true;
        this._log.info({ llm: llm.label() }, 'LLM recovered');
        this.adapter._emitAvailabilityChanged(llm, true);
      } catch {
        // Recovery failed, stay unavailable
      } finally {
        status.recoveringTask = null;
      }
    };

    // Fire and forget
    status.recoveringTask = recoverTask();
  }

  /**
   * Main run method - iterates through LLMs with fallback logic.
   */
  protected async run(): Promise<void> {
    const startTime = Date.now();

    // Check if all LLMs are unavailable
    const allFailed = this.adapter._status.every((s) => !s.available);
    if (allFailed) {
      this._log.error('all LLMs are unavailable, retrying...');
    }

    for (let i = 0; i < this.adapter.llms.length; i++) {
      const llm = this.adapter.llms[i]!;
      const status = this.adapter._status[i]!;

      this._log.debug(
        { llm: llm.label(), index: i, available: status.available, allFailed },
        'checking LLM',
      );

      if (status.available || allFailed) {
        let textSent = '';
        const toolCallsSent: string[] = [];

        try {
          this._log.info({ llm: llm.label() }, 'FallbackAdapter: Attempting provider');

          let chunkCount = 0;
          for await (const chunk of this.tryGenerate(llm, false)) {
            chunkCount++;
            // Track what's been sent
            if (chunk.delta) {
              if (chunk.delta.content) {
                textSent += chunk.delta.content;
              }
              if (chunk.delta.toolCalls) {
                for (const tc of chunk.delta.toolCalls) {
                  if (tc.name) {
                    toolCallsSent.push(tc.name);
                  }
                }
              }
            }

            // Forward chunk to queue
            this._log.debug({ llm: llm.label(), chunkCount }, 'run: forwarding chunk to queue');
            this.queue.put(chunk);
          }

          // Success!
          this._log.info(
            { llm: llm.label(), totalChunks: chunkCount, textLength: textSent.length },
            'FallbackAdapter: Provider succeeded',
          );
          return;
        } catch (error) {
          // Mark as unavailable if it was available before
          if (status.available) {
            status.available = false;
            this.adapter._emitAvailabilityChanged(llm, false);
          }

          // Check if we sent data before failing
          if (textSent || toolCallsSent.length > 0) {
            const extra = { textSent, toolCallsSent };

            if (!this.adapter.retryOnChunkSent) {
              this._log.error(
                { llm: llm.label(), ...extra },
                'failed after sending chunk, skip retrying. Set `retryOnChunkSent` to `true` to enable.',
              );
              throw error;
            }

            this._log.warn(
              { llm: llm.label(), ...extra },
              'failed after sending chunk, retrying...',
            );
          }
        }
      }

      // Trigger background recovery for this LLM
      this.tryRecovery(llm, i);
    }

    // All LLMs failed
    const duration = (Date.now() - startTime) / 1000;
    const labels = this.adapter.llms.map((l) => l.label()).join(', ');
    throw new APIConnectionError({
      message: `all LLMs failed (${labels}) after ${duration.toFixed(2)}s`,
    });
  }
}
