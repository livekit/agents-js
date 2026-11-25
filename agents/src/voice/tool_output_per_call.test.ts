// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Every tool call is answered, whatever the tool did.
 *
 * An LLM re-issues a call it never got back, running its side effects again, and a realtime
 * model waits on it. A tool with nothing to say says so with `replyRequired` instead.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FunctionCallOutput } from '../llm/chat_context.js';
import { ToolResult, handoff, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Agent, StopResponse } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

/**
 * Run one turn whose single tool call runs `behavior`, and return that call's answer. With
 * `replyTo`, the model answers a tool reply to that output with "Done.".
 */
async function run(behavior: () => unknown, { replyTo }: { replyTo?: string } = {}) {
  const llm = new FakeLLM([
    { input: 'Do the thing.', toolCalls: [{ name: 'do_the_thing', args: {} }] },
    ...(replyTo !== undefined ? [{ input: replyTo, content: 'Done.' }] : []),
  ]);
  const chat = vi.spyOn(llm, 'chat');
  const agent = new Agent({
    instructions: 'You are a helpful assistant.',
    tools: {
      do_the_thing: tool({ description: 'Do the thing.', execute: async () => behavior() }),
    },
  });
  const session = new AgentSession({ llm, turnHandling: { turnDetection: 'manual' } });

  await session.start({ agent });
  try {
    await session.generateReply({ userInput: 'Do the thing.' }).waitForPlayout();

    for (const [label, items] of [
      ['agent chat context', agent.chatCtx.items],
      ['session history', session.history.items],
    ] as const) {
      const calls = items.filter((item) => item.type === 'function_call');
      const outputs = items.filter((item) => item.type === 'function_call_output');
      expect(calls, `${label}: the call must be recorded once`).toHaveLength(1);
      expect(outputs, `${label}: the call must be answered exactly once`).toHaveLength(1);
      expect(outputs[0]!.callId).toBe(calls[0]!.callId);
    }

    const output = agent.chatCtx.items.find(
      (item): item is FunctionCallOutput => item.type === 'function_call_output',
    )!;
    return { agent, session, output, inferences: chat.mock.calls.length };
  } finally {
    await session.close();
  }
}

describe('tool output per call', () => {
  it.each([
    { label: 'an invalid output', behavior: () => Symbol('invalid'), errorText: 'invalid output' },
    {
      label: 'two agents',
      behavior: () => [
        handoff({ agent: new Agent({ instructions: 'first' }) }),
        handoff({ agent: new Agent({ instructions: 'second' }) }),
      ],
      errorText: 'more than one agent',
    },
  ])('answers a tool that returned $label as an error', async ({ behavior, errorText }) => {
    // the model can recover from a failure; it cannot recover from silence
    const { agent, session, output } = await run(behavior);

    expect(session.currentAgent, 'an ambiguous handoff must not be applied').toBe(agent);
    expect(output.isError).toBe(true);
    expect(output.output).toContain(errorText);
    expect(output.replyRequired).toBe(true);
  });

  it('answers a StopResponse and asks for no reply', async () => {
    // StopResponse means "say nothing", not "leave the call open"
    const { output, inferences } = await run(() => {
      throw new StopResponse();
    });

    expect(output).toMatchObject({ output: '', isError: false, replyRequired: false });
    expect(inferences, 'no tool reply may follow').toBe(1);
  });

  it('answers a bare handoff and asks for no reply', async () => {
    // a handoff with nothing to say is answered, and the new agent speaks instead
    const nextAgent = new Agent({ instructions: 'You are the next agent.' });
    const { session, output, inferences } = await run(() => handoff({ agent: nextAgent }));

    expect(session.currentAgent, 'the handoff must be applied').toBe(nextAgent);
    expect(output).toMatchObject({ output: '', isError: false, replyRequired: false });
    expect(inferences, 'the old agent must not reply').toBe(1);
  });

  it.each([
    {
      result: () => new ToolResult('Successfully sent DTMF events: 1', { replyRequired: false }),
      expected: JSON.stringify('Successfully sent DTMF events: 1'),
      replyRequired: false,
    },
    {
      result: () => new ToolResult('ok', { replyRequired: true }),
      expected: '"ok"',
      replyRequired: true,
    },
    { result: () => new ToolResult('ok'), expected: '"ok"', replyRequired: true },
    {
      result: () => new ToolResult(undefined, { replyRequired: true }),
      expected: '',
      replyRequired: true,
    },
    {
      result: () => new ToolResult(undefined, { replyRequired: false }),
      expected: '',
      replyRequired: false,
    },
    { result: () => 'ok', expected: '"ok"', replyRequired: true },
    { result: () => undefined, expected: '', replyRequired: false },
  ])(
    'lets the tool result $expected control the follow-up reply ($replyRequired)',
    async ({ result, expected, replyRequired }) => {
      const { agent, session, output, inferences } = await run(result, { replyTo: expected });

      expect(output.isError).toBe(false);
      expect(inferences).toBe(replyRequired ? 2 : 1);
      for (const items of [agent.chatCtx.items, session.history.items]) {
        const outputs = items.filter((item) => item.type === 'function_call_output');
        expect(outputs[0]).toMatchObject({ output: expected, replyRequired });
        const replies = items.filter(
          (item) => item.type === 'message' && item.role === 'assistant',
        );
        expect(replies.map((item) => item.type === 'message' && item.textContent)).toEqual(
          replyRequired ? ['Done.'] : [],
        );
      }
    },
  );

  it('keeps a handoff ToolResult output without requesting a reply', async () => {
    const nextAgent = new Agent({ instructions: 'You are the next agent.' });
    const { session, output, inferences } = await run(
      () =>
        handoff({
          agent: nextAgent,
          returns: new ToolResult('Transferred', { replyRequired: false }),
        }),
      { replyTo: '"Transferred"' },
    );

    expect(session.currentAgent).toBe(nextAgent);
    expect(output).toMatchObject({ output: '"Transferred"', isError: false, replyRequired: false });
    expect(inferences, 'the old agent must not reply').toBe(1);
  });

  it('does not let a ToolResult suppress the replies of other tools', async () => {
    const llm = new FakeLLM([
      {
        input: 'Send DTMF and look it up.',
        content: 'Working on it.',
        toolCalls: [
          { name: 'send_dtmf', args: {} },
          { name: 'lookup', args: {} },
        ],
      },
      { input: '"Sent"', content: 'Done.' },
      { input: '"Found"', content: 'Done.' },
    ]);
    const chat = vi.spyOn(llm, 'chat');
    const agent = new Agent({
      instructions: 'test',
      tools: {
        send_dtmf: tool({
          description: 'Send DTMF events.',
          execute: async () => new ToolResult('Sent', { replyRequired: false }),
        }),
        lookup: tool({ description: 'Look something up.', execute: async () => 'Found' }),
      },
    });
    const session = new AgentSession({ llm, turnHandling: { turnDetection: 'manual' } });

    await session.start({ agent });
    try {
      await session.generateReply({ userInput: 'Send DTMF and look it up.' }).waitForPlayout();

      const outputs = new Map(
        session.history.items
          .filter((item) => item.type === 'function_call_output')
          .map((item) => [item.callId, item]),
      );
      expect([...outputs.keys()].sort()).toEqual(['fake_call_0', 'fake_call_1']);
      expect(outputs.get('fake_call_0')).toMatchObject({ output: '"Sent"', replyRequired: false });
      expect(outputs.get('fake_call_1')).toMatchObject({ output: '"Found"', replyRequired: true });
      const replies = session.history.items.filter(
        (item) => item.type === 'message' && item.role === 'assistant',
      );
      expect(replies.map((item) => item.type === 'message' && item.textContent)).toEqual([
        'Working on it.',
        'Done.',
      ]);
      expect(chat).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });
});
