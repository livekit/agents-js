// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import type { LLMMetrics } from '../metrics/base.js';
import { AsyncIterableQueue } from '../utils.js';
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

export type LLMCallbacks = {
  ['metrics_collected']: (metrics: LLMMetrics) => void;
};

export abstract class LLM extends (EventEmitter as new () => TypedEmitter<LLMCallbacks>) {
  /**
   * Returns a {@link LLMStream} that can be used to push text and receive LLM responses.
   */
  abstract chat({
    chatCtx,
    toolCtx,
    toolChoice,
    temperature,
    n,
    parallelToolCalls,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    toolChoice?: ToolChoice;
    temperature?: number;
    n?: number;
    parallelToolCalls?: boolean;
  }): LLMStream;
}

export abstract class LLMStream implements AsyncIterableIterator<ChatChunk> {
  protected output = new AsyncIterableQueue<ChatChunk>();
  protected queue = new AsyncIterableQueue<ChatChunk>();
  protected closed = false;
  protected abortController = new AbortController();
  protected logger = log();
  abstract label: string;

  #llm: LLM;
  #chatCtx: ChatContext;
  #toolCtx?: ToolContext;

  constructor(llm: LLM, chatCtx: ChatContext, toolCtx?: ToolContext) {
    this.#llm = llm;
    this.#chatCtx = chatCtx;
    this.#toolCtx = toolCtx;
    this.monitorMetrics();
    this.abortController.signal.addEventListener('abort', () => {
      // TODO (AJS-37) clean this up when we refactor with streams
      this.output.close();
      this.closed = true;
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
    const metrics: LLMMetrics = {
      type: 'llm_metrics',
      timestamp: Date.now(),
      requestId,
      ttft: ttft === BigInt(-1) ? -1 : Math.trunc(Number(ttft / BigInt(1000000))),
      duration: Math.trunc(Number(duration / BigInt(1000000))),
      cancelled: this.abortController.signal.aborted,
      label: this.label,
      completionTokens: usage?.completionTokens || 0,
      promptTokens: usage?.promptTokens || 0,
      promptCachedTokens: usage?.promptCachedTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      tokensPerSecond:
        (usage?.completionTokens || 0) / Math.trunc(Number(duration / BigInt(1000000000))),
    };
    this.#llm.emit('metrics_collected', metrics);
  }

  /** The function context of this stream. */
  get toolCtx(): ToolContext | undefined {
    return this.#toolCtx;
  }

  /** The initial chat context of this stream. */
  get chatCtx(): ChatContext {
    return this.#chatCtx;
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
