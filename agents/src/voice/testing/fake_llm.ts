// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext } from '../../llm/chat_context.js';
import { FunctionCall } from '../../llm/chat_context.js';
import { LLMStream as BaseLLMStream, LLM, type LLMStream } from '../../llm/llm.js';
import type { ToolChoice, ToolContext } from '../../llm/tool_context.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { delay } from '../../utils.js';

export interface FakeLLMResponse {
  input: string;
  type?: 'llm';
  content?: string;
  ttft?: number;
  duration?: number;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export class FakeLLM extends LLM {
  private readonly responseMap = new Map<string, FakeLLMResponse>();

  constructor(responses: FakeLLMResponse[] = []) {
    super();
    for (const response of responses) {
      this.responseMap.set(response.input, {
        type: 'llm',
        ttft: 0,
        duration: 0,
        ...response,
      });
    }
  }

  label(): string {
    return 'fake-llm';
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    return new FakeLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions,
    });
  }

  lookup(input: string): FakeLLMResponse | undefined {
    return this.responseMap.get(input);
  }
}

class FakeLLMStream extends BaseLLMStream {
  private readonly fake: FakeLLM;

  constructor(
    fake: FakeLLM,
    params: { chatCtx: ChatContext; toolCtx?: ToolContext; connOptions: APIConnectOptions },
  ) {
    super(fake, params);
    this.fake = fake;
  }

  protected async run(): Promise<void> {
    const input = this.getInputText();
    const decision = this.fake.lookup(input);
    if (!decision) {
      return;
    }

    const startedAt = Date.now();
    if ((decision.ttft ?? 0) > 0) {
      await delay(decision.ttft!);
    }

    const content = decision.content ?? '';
    const chunkSize = 3;
    for (let i = 0; i < content.length; i += chunkSize) {
      this.queue.put({
        id: 'fake',
        delta: { role: 'assistant', content: content.slice(i, i + chunkSize) },
      });
    }

    if (decision.toolCalls && decision.toolCalls.length > 0) {
      const calls = decision.toolCalls.map((tc, index) =>
        FunctionCall.create({
          callId: `fake_call_${index}`,
          name: tc.name,
          args: JSON.stringify(tc.args),
        }),
      );
      this.queue.put({
        id: 'fake',
        delta: { role: 'assistant', toolCalls: calls },
      });
    }

    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(0, (decision.duration ?? 0) - elapsed);
    if (waitMs > 0) {
      await delay(waitMs);
    }
  }

  private getInputText(): string {
    const items = this.chatCtx.items;
    if (items.length === 0) {
      throw new Error('No input text found');
    }

    for (const item of items) {
      if (item.type === 'message' && item.role === 'system') {
        const text = item.textContent ?? '';
        const lines = text.split('\n');
        const tail = lines[lines.length - 1] ?? '';
        if (lines.length > 1 && tail.startsWith('instructions:')) {
          return tail;
        }
      }
    }

    const last = items[items.length - 1]!;
    if (last.type === 'message' && last.role === 'user') return last.textContent ?? '';
    if (last.type === 'function_call_output') return last.output;
    throw new Error('No input text found');
  }
}
