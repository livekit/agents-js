// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError } from '../_exceptions.js';
import { log } from '../log.js';
import type { LLMMetrics } from '../metrics/base.js';
import type { APIConnectOptions } from '../types.js';
import type { ChatContext } from './chat_context.js';
import { LLM, LLMStream } from './llm.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

export interface FallbackAdapterOptions {
  llms: LLM[];
  attemptTimeout?: number;
  maxRetryPerLLM?: number;
  retryInterval?: number;
  retryOnChunkSent?: boolean;
}

interface LLMStatus {
  available: boolean;
  recoveringPromise?: Promise<void>;
}

export interface AvailabilityChangedEvent {
  llm: LLM;
  available: boolean;
}

export type FallbackLLMCallbacks = {
  metrics_collected: (metrics: LLMMetrics) => void;
  llm_availability_changed: (event: AvailabilityChangedEvent) => void;
  error: (error: Error) => void;
};

export class FallbackAdapter extends LLM {
  public llms: LLM[];
  public options: Required<Omit<FallbackAdapterOptions, 'llms'>>;
  public status: Map<LLM, LLMStatus>;

  private _boundListeners: Map<LLM, (metrics: LLMMetrics) => void>;

  constructor(options: FallbackAdapterOptions) {
    super();
    if (options.llms.length < 1) {
      throw new Error('At least one LLM instance must be provided.');
    }

    this.llms = options.llms;
    this.options = {
      attemptTimeout: options.attemptTimeout ?? 5.0,
      maxRetryPerLLM: options.maxRetryPerLLM ?? 0,
      retryInterval: options.retryInterval ?? 0.5,
      retryOnChunkSent: options.retryOnChunkSent ?? false,
    };

    this.status = new Map();
    this._boundListeners = new Map();

    this.llms.forEach((llm) => {
      this.status.set(llm, { available: true });

      const onMetrics = (metrics: LLMMetrics) => {
        this.emit('metrics_collected', metrics);
      };
      llm.on('metrics_collected', onMetrics);
      this._boundListeners.set(llm, onMetrics);
    });
  }

  get model(): string {
    return 'FallbackAdapter';
  }

  get provider(): string {
    return 'livekit';
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
    const effectiveOpts = {
      timeoutMs: (this.options.attemptTimeout || 5) * 1000,
      retryIntervalMs: (this.options.retryInterval || 0.5) * 1000,
      ...(opts.connOptions || {}),
      maxRetry: 0,
    } as APIConnectOptions;

    return new FallbackLLMStream(this, {
      ...opts,
      connOptions: effectiveOpts,
    });
  }

  async aclose(): Promise<void> {
    this.llms.forEach((llm) => {
      const listener = this._boundListeners.get(llm);
      if (listener) {
        llm.off('metrics_collected', listener);
      }
    });
    this._boundListeners.clear();
    await super.aclose();
  }

  markFailed(llm: LLM, chatCtx: ChatContext) {
    const s = this.status.get(llm);

    if (s && s.available) {
      s.available = false;

      (this as any).emit('llm_availability_changed', { llm, available: false });

      this.triggerRecovery(llm, chatCtx);
    }
  }

  private triggerRecovery(llm: LLM, chatCtx: ChatContext) {
    const s = this.status.get(llm);

    if (!s || s.recoveringPromise) return;

    s.recoveringPromise = (async () => {
      const logger = log();
      try {
        await new Promise((resolve) => setTimeout(resolve, this.options.retryInterval * 1000));

        logger.debug(`FallbackAdapter: Checking health of ${llm.label()}`);

        const stream = llm.chat({
          chatCtx: chatCtx,
          connOptions: {
            timeoutMs: 5000,
            maxRetry: 0,
            retryIntervalMs: 0,
          },
        });

        for await (const _ of stream) {
          break;
        }

        s.available = true;
        (this as any).emit('llm_availability_changed', { llm, available: true });
        logger.info(`FallbackAdapter: Provider ${llm.label()} recovered.`);
      } catch (e) {
        logger.warn(`FallbackAdapter: Recovery check failed for ${llm.label()}`);
      } finally {
        s.recoveringPromise = undefined;
      }
    })();
  }
}

class FallbackLLMStream extends LLMStream {
  private adapter: FallbackAdapter;
  private _currentStream?: LLMStream;

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
    super(adapter, opts);
    this.adapter = adapter;
  }

  get chatCtx(): ChatContext {
    return this._currentStream?.chatCtx ?? super.chatCtx;
  }

  get toolCtx(): ToolContext | undefined {
    return this._currentStream?.toolCtx ?? super.toolCtx;
  }

  async run(): Promise<void> {
    const logger = log();
    const start = Date.now();

    try {
      const allFailed = Array.from(this.adapter.status.values()).every((s) => !s.available);
      if (allFailed) {
        logger.error('All LLMs are unavailable, retrying...');
      }

      let candidates = this.adapter.llms.filter((llm) => this.adapter.status.get(llm)?.available);
      if (allFailed || candidates.length === 0) {
        candidates = this.adapter.llms;
      }

      for (const llm of candidates) {
        let textSent = '';
        const toolCallsSent: string[] = [];

        try {
          logger.debug({ label: llm.label() }, 'FallbackAdapter: Attempting provider');

          const childStream = llm.chat({
            chatCtx: this.chatCtx,
            toolCtx: this.toolCtx,
            connOptions: {
              ...this.connOptions,
              timeoutMs: (this.adapter.options.attemptTimeout || 5) * 1000,
              maxRetry: this.adapter.options.maxRetryPerLLM,
            },
          });

          this._currentStream = childStream;

          for await (const chunk of childStream) {
            if (chunk.delta) {
              if (chunk.delta.content) textSent += chunk.delta.content;
              if (chunk.delta.toolCalls) {
                chunk.delta.toolCalls.forEach((tc) => {
                  if (tc.name) toolCallsSent.push(tc.name);
                });
              }
            }
            this.queue.put(chunk);
          }

          logger.debug({ label: llm.label() }, 'FallbackAdapter: Provider succeeded');
          return;
        } catch (error) {
          const hasSentData = textSent.length > 0 || toolCallsSent.length > 0;
          const logContext = { label: llm.label(), error, textSent, toolCallsSent };

          if (hasSentData && !this.adapter.options.retryOnChunkSent) {
            logger.error(logContext, 'Provider failed after sending data. Aborting fallback.');
            throw error;
          }

          logger.warn(logContext, 'FallbackAdapter: Provider failed, switching...');
          this.adapter.markFailed(llm, this.chatCtx);
        } finally {
          this._currentStream = undefined;
        }
      }

      const duration = (Date.now() - start) / 1000;
      throw new APIConnectionError({
        message: `All Fallback LLMs failed after ${duration}s`,
      });
    } finally {
      this.queue.close();
    }
  }
}
