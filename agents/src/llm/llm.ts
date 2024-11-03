// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue } from '../utils.js';
import type { ChatContext, ChatRole } from './chat_context.js';
import type {
  CallableFunctionResult,
  DeferredFunction,
  FunctionContext,
} from './function_context.js';

export interface ChoiceDelta {
  role: ChatRole;
  content?: string;
  toolCalls?: FunctionContext;
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

export abstract class LLM {
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
  protected queue = new AsyncIterableQueue<ChatChunk>();
  protected closed = false;
  protected functionCalls: DeferredFunction[] = [];

  #chatCtx: ChatContext;
  #fncCtx?: FunctionContext;

  constructor(chatCtx: ChatContext, fncCtx?: FunctionContext) {
    this.#chatCtx = chatCtx;
    this.#fncCtx = fncCtx;
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
  async executeFunctions(): Promise<CallableFunctionResult[]> {
    return Promise.all(
      this.functionCalls.map((f) =>
        f.func.execute(f.params).then(
          (result) => ({ name: f.name, toolCallId: f.toolCallId, result }),
          (error) => ({ name: f.name, toolCallId: f.toolCallId, error }),
        ),
      ),
    );
  }

  next(): Promise<IteratorResult<ChatChunk>> {
    return this.queue.next();
  }

  close() {
    this.queue.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): LLMStream {
    return this;
  }
}
