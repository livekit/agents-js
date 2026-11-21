// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChatContext } from '../llm/chat_context.js';
import type { LLMStream } from '../llm/llm.js';
import { type ToolChoice, type ToolContextLike, tool } from '../llm/tool_context.js';
import type { APIConnectOptions } from '../types.js';
import { delay } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM, type FakeLLMResponse } from './testing/fake_llm.js';
import { UPDATE_TEMPLATE } from './tool_executor.js';

const BASE = 'You are a helpful agent.';
const GUIDANCE = 'instructions: deliver the result';

interface Request {
  systemMessages: string[];
  toolChoice?: ToolChoice;
}

class RecordingLLM extends FakeLLM {
  readonly requests: Request[] = [];

  constructor(responses: FakeLLMResponse[]) {
    super(responses);
  }

  override chat(params: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    this.requests.push({
      systemMessages: params.chatCtx.items.flatMap((item) =>
        item.type === 'message' && item.role === 'system' ? [item.textContent ?? ''] : [],
      ),
      toolChoice: params.toolChoice,
    });
    return super.chat(params);
  }

  requestWith(text: string): Request | undefined {
    return this.requests.find((request) => request.systemMessages.some((m) => m.includes(text)));
  }
}

let session: AgentSession | undefined;

afterEach(async () => {
  await session?.close();
  session = undefined;
});

function startSession(llm: RecordingLLM, agent: Agent) {
  session = new AgentSession({
    llm,
    vad: null,
    turnHandling: { turnDetection: null },
    toolHandling: {
      asyncOptions: { replyAtTailTemplate: GUIDANCE, replyMaybeCoveredTemplate: GUIDANCE },
    },
  });
  return session.start({ agent }).then(() => session!);
}

async function settle(wait: Promise<unknown>) {
  return Promise.race([wait.then(() => 'settled'), delay(2000).then(() => 'pending')]);
}

describe('per-reply instructions', () => {
  it('reach the deferred reply to an async tool result as their own system message', async () => {
    const llm = new RecordingLLM([
      { input: 'go', toolCalls: [{ name: 'lookup', args: {} }] },
      {
        input: JSON.stringify(
          UPDATE_TEMPLATE.replace('{functionName}', 'lookup').replace('{message}', 'started'),
        ),
        content: 'Working on it.',
        duration: 150,
      },
      { input: GUIDANCE, content: 'Here is the result.' },
      { input: 'next', content: 'Sure.' },
    ]);
    const agent = new Agent({
      instructions: BASE,
      tools: {
        lookup: tool({
          description: 'Look something up',
          parameters: z.object({}),
          execute: async (_, { ctx }) => {
            await ctx.update('started');
            await delay(25);
            return 'final result';
          },
        }),
      },
    });
    const s = await startSession(llm, agent);

    expect(await settle(s.run({ userInput: 'go' }).wait())).toBe('settled');
    expect(await settle(s.run({ userInput: 'next' }).wait())).toBe('settled');

    const reply = llm.requestWith(GUIDANCE);
    expect(reply?.systemMessages).toEqual([BASE, GUIDANCE]);
    expect(reply?.toolChoice).not.toBe('none');

    const next = llm.requests[llm.requests.length - 1]!;
    expect(next.systemMessages).toEqual([BASE]);
  });

  it('reach a plain generateReply as their own system message', async () => {
    const greeting = 'instructions: greet the user';
    const llm = new RecordingLLM([
      { input: greeting, content: 'Hello!' },
      { input: 'next', content: 'Sure.' },
    ]);
    const s = await startSession(llm, new Agent({ instructions: BASE }));

    expect(await settle(s.generateReply({ instructions: greeting }).waitForPlayout())).toBe(
      'settled',
    );
    expect(await settle(s.run({ userInput: 'next' }).wait())).toBe('settled');

    expect(llm.requestWith(greeting)?.systemMessages).toEqual([BASE, greeting]);
    expect(llm.requests[llm.requests.length - 1]!.systemMessages).toEqual([BASE]);
  });

  it('are kept once in the tool reply step that follows', async () => {
    const lookupFirst = 'instructions: look it up first';
    const llm = new RecordingLLM([
      { input: lookupFirst, toolCalls: [{ name: 'lookup', args: {} }] },
      { input: JSON.stringify('final result'), content: 'Done.' },
    ]);
    const agent = new Agent({
      instructions: BASE,
      tools: {
        lookup: tool({
          description: 'Look something up',
          parameters: z.object({}),
          execute: async () => 'final result',
        }),
      },
    });
    const s = await startSession(llm, agent);

    expect(await settle(s.generateReply({ instructions: lookupFirst }).waitForPlayout())).toBe(
      'settled',
    );

    expect(llm.requests.map((request) => request.systemMessages)).toEqual([
      [BASE, lookupFirst],
      [BASE, lookupFirst],
    ]);
  });
});
