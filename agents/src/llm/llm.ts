// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { LLMMetrics } from '../metrics/base.js';
import { AsyncIterableQueue } from '../utils.js';
import type { ChatContext, ChatRole } from './chat_context.js';
import type { FunctionCallInfo, FunctionContext } from './function_context.js';

export interface ChoiceDelta {
  role: ChatRole;
  content?: string;
  toolCalls?: FunctionCallInfo[];
}

export interface CompletionUsage {
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
}

export interface Choice {
  delta: ChoiceDelta;
  index: number;
}

export interface ChatChunk {
  requestId: string;
  choices: Choice[];
  usage?: CompletionUsage;
}

export enum LLMEvent {
  METRICS_COLLECTED,
}

export type LLMCallbacks = {
  [LLMEvent.METRICS_COLLECTED]: (metrics: LLMMetrics) => void;
};

export abstract class LLM extends (EventEmitter as new () => TypedEmitter<LLMCallbacks>) {
  /**
   * Returns a {@link LLMStream} that can be used to push text and receive LLM responses.
   */
  abstract chat({
    chatCtx,
    fncCtx,
    temperature,
    n,
    parallelToolCalls,
  }: {
    chatCtx: ChatContext;
    fncCtx?: FunctionContext;
    temperature?: number;
    n?: number;
    parallelToolCalls?: boolean;
  }): LLMStream;
}

export abstract class LLMStream implements AsyncIterableIterator<ChatChunk> {
  protected output = new AsyncIterableQueue<ChatChunk>();
  protected queue = new AsyncIterableQueue<ChatChunk>();
  protected closed = false;
  protected _functionCalls: FunctionCallInfo[] = [];
  abstract label: string;

  #llm: LLM;
  #chatCtx: ChatContext;
  #fncCtx?: FunctionContext;

  constructor(llm: LLM, chatCtx: ChatContext, fncCtx?: FunctionContext) {
    this.#llm = llm;
    this.#chatCtx = chatCtx;
    this.#fncCtx = fncCtx;
    this.monitorMetrics();
  }

  protected async monitorMetrics() {
    const startTime = process.hrtime.bigint();
    let ttft: bigint | undefined;
    let requestId = '';
    let usage: CompletionUsage | undefined;

    for await (const ev of this.queue) {
      this.output.put(ev);
      requestId = ev.requestId;
      if (!ttft) {
        ttft = process.hrtime.bigint() - startTime;
      }
      if (ev.usage) {
        usage = ev.usage;
      }
    }
    this.output.close();

    const duration = process.hrtime.bigint() - startTime;
    const metrics: LLMMetrics = {
      timestamp: Date.now(),
      requestId,
      ttft: Math.trunc(Number(ttft! / BigInt(1000000))),
      duration: Math.trunc(Number(duration / BigInt(1000000))),
      cancelled: false, // XXX(nbsp)
      label: this.label,
      completionTokens: usage?.completionTokens || 0,
      promptTokens: usage?.promptTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      tokensPerSecond:
        (usage?.completionTokens || 0) / Math.trunc(Number(duration / BigInt(1000000000))),
    };
    this.#llm.emit(LLMEvent.METRICS_COLLECTED, metrics);
  }

  /** List of called functions from this stream. */
  get functionCalls(): FunctionCallInfo[] {
    return this._functionCalls;
  }

  /** The function context of this stream. */
  get fncCtx(): FunctionContext | undefined {
    return this.#fncCtx;
  }

  /** The initial chat context of this stream. */
  get chatCtx(): ChatContext {
    return this.#chatCtx;
  }

  /** Execute all deferred functions of this stream concurrently. */
  executeFunctions(): FunctionCallInfo[] {
    this._functionCalls.forEach(
      (f) =>
        (f.task = f.func.execute(f.params).then(
          (result) => ({ name: f.name, toolCallId: f.toolCallId, result }),
          (error) => ({ name: f.name, toolCallId: f.toolCallId, error }),
        )),
    );
    return this._functionCalls;
  }

  next(): Promise<IteratorResult<ChatChunk>> {
    return this.output.next();
  }

  close() {
    this.output.close();
    this.queue.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): LLMStream {
    return this;
  }
}
