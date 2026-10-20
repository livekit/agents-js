// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import type { LLMStream } from '../llm/llm.js';
import { type ToolChoice, tool } from '../llm/tool_context.js';
import { delay } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import type { RunContext as RunContextType } from './run_context.js';
import { RunContext } from './run_context.js';
import { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';
import { ToolExecutor, UPDATE_TEMPLATE, _replyToolChoice } from './tool_executor.js';

describe('_replyToolChoice', () => {
  it('honours a shared request', () => {
    expect(_replyToolChoice(['none', 'none'])).toBe('none');
  });

  it('leaves a result on the model default', () => {
    expect(_replyToolChoice([undefined])).toBeUndefined();
  });

  it('needs only one result among reports to leave the choice open', () => {
    expect(_replyToolChoice(['none', undefined])).toBeUndefined();
  });

  it('constrains nothing when requests disagree', () => {
    expect(_replyToolChoice(['none', 'auto'])).toBeUndefined();
  });

  it('compares a named tool by value', () => {
    const named: ToolChoice = { type: 'function', function: { name: 'look_up' } };
    expect(_replyToolChoice([named, { ...named, function: { name: 'look_up' } }])).toEqual(named);
    expect(_replyToolChoice([named, 'none'])).toBeUndefined();
  });
});

describe('ToolExecutor deferred reply', () => {
  function build() {
    const agent = {
      chatCtx: ChatContext.empty(),
      async updateChatCtx(chatCtx: ChatContext) {
        this.chatCtx = chatCtx;
      },
    };
    const replies: Array<{ toolChoice?: ToolChoice }> = [];
    const session = {
      userData: {},
      history: new ChatContext(),
      currentAgent: agent,
      _globalRunState: undefined,
      async waitForIdle() {
        return { agent };
      },
      generateReply: (options: { toolChoice?: ToolChoice }) => {
        replies.push(options);
        return { id: 'speech_reply', addDoneCallback: () => {} };
      },
    } as unknown as AgentSession;
    const functionCall = FunctionCall.create({ callId: 'c1', name: 'progress', args: '{}' });
    const runCtx = new RunContext(session, SpeechHandle.create(), functionCall);
    return { runCtx, agent, replies };
  }

  async function run(execute: (ctx: RunContextType) => Promise<unknown>) {
    const { runCtx, agent, replies } = build();
    const executor = new ToolExecutor();
    const progress = tool({
      name: 'progress',
      description: 'p',
      parameters: z.object({}),
      execute: async (_, { ctx }) => execute(ctx),
    });
    await executor.execute({ tool: progress, runCtx, rawArguments: {} });
    await executor.waitForAll();
    return { runCtx, agent, replies };
  }

  it('records a silent update but never replies to it', async () => {
    const { agent, replies } = await run(async (ctx) => {
      await ctx.update('step one');
      await ctx.update('step two', { silent: true });
      return 'all done';
    });

    const outputs = agent.chatCtx.items
      .filter((item) => item.type === 'function_call_output')
      .map((item) => item.callId);
    expect(outputs).toEqual(['c1_update_1', 'c1_final']);
    // only the final return is voiced
    expect(replies).toHaveLength(1);
  });

  it('marks a silent first update so its tool reply is dropped', async () => {
    const { runCtx } = await run(async (ctx) => {
      await ctx.update('on it', { silent: true });
      return undefined;
    });
    expect(runCtx._suppressReply).toBe(true);
  });

  it('keeps a reply covering only reports from calling tools', async () => {
    const { replies } = await run(async (ctx) => {
      await ctx.update('on it');
      await ctx.update('still on it');
      return undefined;
    });
    expect(replies.map((reply) => reply.toolChoice)).toEqual(['none']);
  });

  it('lets a report ask for the tools', async () => {
    const { replies } = await run(async (ctx) => {
      await ctx.update('on it');
      await ctx.update('three matches, which one?', { toolChoice: 'auto' });
      return undefined;
    });
    expect(replies.map((reply) => reply.toolChoice)).toEqual(['auto']);
  });

  it('leaves the reply to a result on the default tool choice', async () => {
    const { replies } = await run(async (ctx) => {
      await ctx.update('on it');
      return 'three matches';
    });
    expect(replies.map((reply) => reply.toolChoice)).toEqual([undefined]);
  });
});

class RecordingLLM extends FakeLLM {
  readonly calls: Array<ToolChoice | undefined> = [];

  chat(params: Parameters<FakeLLM['chat']>[0]): LLMStream {
    this.calls.push(params.toolChoice);
    return super.chat(params);
  }
}

describe('ctx.update() through an AgentSession', () => {
  async function runSession(silent: boolean) {
    const llm = new RecordingLLM([
      { input: 'go', toolCalls: [{ name: 'lookup', args: {} }] },
      {
        // tool outputs reach the model JSON-encoded
        input: JSON.stringify(
          UPDATE_TEMPLATE.replace('{functionName}', 'lookup').replace('{message}', 'started'),
        ),
        content: 'Working on it.',
      },
      { input: 'instructions: deliver the result', content: 'Here is the result.' },
    ]);
    const agent = new Agent({
      instructions: 'test',
      tools: {
        lookup: tool({
          description: 'Look something up',
          parameters: z.object({}),
          execute: async (_, { ctx }) => {
            await ctx.update('started', { silent });
            await delay(50);
            return 'final result';
          },
        }),
      },
    });
    const session = new AgentSession({
      llm,
      vad: null,
      turnHandling: { turnDetection: null },
      toolHandling: {
        asyncOptions: {
          replyAtTailTemplate: 'instructions: deliver the result',
          replyMaybeCoveredTemplate: 'instructions: deliver the result',
        },
      },
    });
    try {
      await session.start({ agent });
      await session.run({ userInput: 'go' }).wait();
      await delay(300);
      return llm.calls;
    } finally {
      await session.close();
    }
  }

  it('answers a report without tools and the result with the default', async () => {
    // user turn, reply to the report, reply to the result
    expect(await runSession(false)).toEqual([undefined, 'none', undefined]);
  });

  it('skips the reply to a silent first update', async () => {
    expect(await runSession(true)).toEqual([undefined, undefined]);
  });
});
