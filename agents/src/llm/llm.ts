// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import type { LLMMetrics } from '../metrics/base.js';
import { AsyncIterableQueue } from '../utils.js';
import type { ChatContext, ChatRole, FunctionCall } from './chat_context.js';
import type { ToolContext } from './tool_context.js';

export interface ChoiceDelta {
  role: ChatRole;
  content?: string;
  toolCalls?: FunctionCall[];
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
    toolCtx,
    temperature,
    n,
    parallelToolCalls,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    temperature?: number;
    n?: number;
    parallelToolCalls?: boolean;
  }): LLMStream;
}

export abstract class LLMStream implements AsyncIterableIterator<ChatChunk> {
  protected output = new AsyncIterableQueue<ChatChunk>();
  protected queue = new AsyncIterableQueue<ChatChunk>();
  protected closed = false;
  protected _functionCalls: FunctionCall[] = [];
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
      this.output.close();
      // TODO (AJS-37) clean this up when we refactor with streams
      this.closed = true;
    });
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
  get functionCalls(): FunctionCall[] {
    return this._functionCalls;
  }

  /** The function context of this stream. */
  get toolCtx(): ToolContext | undefined {
    return this.#toolCtx;
  }

  /** The initial chat context of this stream. */
  get chatCtx(): ChatContext {
    return this.#chatCtx;
  }

  /** Execute all deferred functions of this stream concurrently. */
  executeFunctions(): FunctionCall[] {
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
    this.abortController.abort();
  }

  [Symbol.asyncIterator](): LLMStream {
    return this;
  }
}
