// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Tests for the structured-output retry behavior of session.run({ outputType })
// (ported from livekit/agents#6080): when a turn ends without the expected
// output, the run re-prompts the model up to maxRetries times before rejecting
// with UnexpectedModelBehavior.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UnexpectedModelBehavior } from '../../_exceptions.js';
import type { ChatContext } from '../../llm/chat_context.js';
import { FunctionCall } from '../../llm/chat_context.js';
import { LLMStream as BaseLLMStream, LLM, type LLMStream } from '../../llm/llm.js';
import { tool } from '../../llm/tool_context.js';
import type { ToolChoice, ToolContextLike } from '../../llm/tool_context.js';
import { initializeLogger } from '../../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { AgentTask } from '../agent.js';
import { AgentSession } from '../agent_session.js';

type ScriptedResponse = { content?: string; toolCall?: { name: string; args: object } };

/** Returns the Nth scripted response on the Nth chat() call, ignoring input. */
class ScriptedLLM extends LLM {
  calls = 0;
  systemTexts: string[] = [];

  constructor(private script: ScriptedResponse[]) {
    super();
  }

  label(): string {
    return 'scripted-llm';
  }

  chat(params: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    for (const item of params.chatCtx.items) {
      if (item.type === 'message' && item.role === 'system') {
        this.systemTexts.push(item.textContent ?? '');
      }
    }
    const idx = Math.min(this.calls, this.script.length - 1);
    this.calls += 1;
    return new ScriptedLLMStream(this, this.script[idx]!, {
      chatCtx: params.chatCtx,
      toolCtx: params.toolCtx,
      connOptions: params.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}

class ScriptedLLMStream extends BaseLLMStream {
  constructor(
    llm: ScriptedLLM,
    private response: ScriptedResponse,
    params: { chatCtx: ChatContext; toolCtx?: ToolContextLike; connOptions: APIConnectOptions },
  ) {
    super(llm, params);
  }

  protected async run(): Promise<void> {
    if (this.response.content) {
      this.queue.put({
        id: 'scripted',
        delta: { role: 'assistant', content: this.response.content },
      });
    }
    if (this.response.toolCall) {
      this.queue.put({
        id: 'scripted',
        delta: {
          role: 'assistant',
          toolCalls: [
            FunctionCall.create({
              callId: 'scripted_call',
              name: this.response.toolCall.name,
              args: JSON.stringify(this.response.toolCall.args),
            }),
          ],
        },
      });
    }
  }
}

const outputSchema = z.object({ answer: z.string() });

class OutputTask extends AgentTask<{ answer: string }> {
  constructor() {
    super({
      instructions: 'Answer via the submit tool.',
      tools: [
        tool({
          name: 'submit',
          description: 'Submit the final answer.',
          parameters: z.object({ answer: z.string() }),
          execute: async ({ answer }) => {
            this.complete({ answer });
            return 'submitted';
          },
        }),
      ],
    });
  }
}

async function runWith(
  llm: ScriptedLLM,
  outputOptions?: { maxRetries?: number; retryInstructions?: string } | null,
) {
  const session = new AgentSession({ llm });
  await session.start({ agent: new OutputTask() });
  try {
    const run = session.run({
      userInput: 'hi',
      outputType: outputSchema,
      ...(outputOptions !== undefined ? { outputOptions } : {}),
    });
    await Promise.race([
      run.wait(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('run timed out')), 10_000)),
    ]);
    return { run, error: undefined as unknown };
  } catch (error) {
    return { run: undefined, error };
  } finally {
    await session.close().catch(() => {});
  }
}

describe('session.run output retries', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('retries and succeeds when the model calls the tool on the second turn', async () => {
    const llm = new ScriptedLLM([
      { content: 'I think the answer is 42.' }, // prose only -> retry
      { toolCall: { name: 'submit', args: { answer: '42' } } },
      { content: 'done' }, // reply to the tool output
    ]);
    const { run, error } = await runWith(llm);
    expect(error).toBeUndefined();
    expect(run!.finalOutput).toEqual({ answer: '42' });
    expect(llm.calls).toBeGreaterThanOrEqual(2);
  });

  it('rejects with UnexpectedModelBehavior after exhausting retries', async () => {
    const llm = new ScriptedLLM([{ content: 'still just prose' }]);
    const { error } = await runWith(llm);
    expect(error).toBeInstanceOf(UnexpectedModelBehavior);
    // initial turn + 2 default retries
    expect(llm.calls).toBe(3);
  });

  it('outputOptions: null disables retries and fails on the first miss', async () => {
    const llm = new ScriptedLLM([{ content: 'prose' }]);
    const { error } = await runWith(llm, null);
    expect(error).toBeInstanceOf(UnexpectedModelBehavior);
    expect(llm.calls).toBe(1);
  });

  it('honors maxRetries and custom retryInstructions', async () => {
    const llm = new ScriptedLLM([{ content: 'prose forever' }]);
    const retryInstructions = 'CUSTOM_RETRY_MARKER: call submit now.';
    const { error } = await runWith(llm, { maxRetries: 1, retryInstructions });
    expect(error).toBeInstanceOf(UnexpectedModelBehavior);
    expect(llm.calls).toBe(2);
    // the retry turn's per-turn instructions must reach the model
    expect(llm.systemTexts.some((text) => text.includes('CUSTOM_RETRY_MARKER'))).toBe(true);
  });
});
