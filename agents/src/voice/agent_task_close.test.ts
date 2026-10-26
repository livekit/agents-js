// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { ToolError, tool } from '../llm/tool_context.js';
import { Future, Task } from '../utils.js';
import { Agent, AgentTask } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

it.each(['before completion', 'during onExit', 'during resume'] as const)(
  'preserves the task error when the session closes %s',
  async (timing) => {
    const entered = new Future<void>();
    const exiting = new Future<void>();
    const notificationDone = new Future<void>();
    const result = new Future<unknown>();
    const failure = new ToolError('caller hung up before the transfer completed');
    const transfer = AgentTask.create<void>({
      instructions: 'transfer',
      onEnter: async () => {
        entered.resolve();
      },
      onExit: async () => {
        exiting.resolve();
        await notificationDone.await;
      },
    });
    const agent = new Agent({
      instructions: 'support',
      tools: [
        tool({
          name: 'transfer',
          description: 'Transfer the caller.',
          execute: async () => {
            try {
              await transfer.run();
            } catch (error) {
              result.resolve(error);
              throw error;
            }
          },
        }),
      ],
    });
    const llm = new FakeLLM([{ input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] }]);
    const chat = vi.spyOn(llm, 'chat');
    const session = new AgentSession({ llm });
    let closing: Promise<void> | undefined;
    const originalResume = AgentActivity.prototype.resume;
    const resume = vi.spyOn(AgentActivity.prototype, 'resume').mockImplementation(function (
      this: AgentActivity,
      options,
    ) {
      if (timing === 'during resume') closing = session.close();
      return originalResume.call(this, options);
    });
    try {
      await session.start({ agent });
      const originalActivity = agent._agentActivity!;
      session.generateReply({ userInput: 'transfer' });
      await entered.await;
      if (timing === 'before completion') closing = session.close();
      transfer.complete(failure);
      await exiting.await;
      if (timing === 'during onExit') closing = session.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(result.done).toBe(false);
      notificationDone.resolve();
      await result.await;
      await closing;

      expect(await result.await).toBe(failure);
      expect(resume).toHaveBeenCalledOnce();
      expect(chat).toHaveBeenCalledOnce();
      expect(agent._agentActivity).toBeUndefined();
      expect(transfer._agentActivity).toBeUndefined();
      expect(originalActivity.schedulingPaused).toBe(true);
    } finally {
      notificationDone.resolve();
      await session.close();
      resume.mockRestore();
      chat.mockRestore();
    }
  },
  10_000,
);

it.each([1, 2])('cancels and unwinds %i pending tasks before closing the parent', async (depth) => {
  const entered = new Future<void>();
  const result = new Future<unknown>();
  const tasks: AgentTask<void>[] = [];
  const createTask = (remaining: number): AgentTask<void> => {
    const task = AgentTask.create<void>({
      instructions: 'transfer',
      onEnter: async () => {
        if (remaining === 1) {
          entered.resolve();
        } else {
          try {
            await createTask(remaining - 1).run();
          } catch (error) {
            expect(error).toBeInstanceOf(ToolError);
          }
        }
      },
    });
    tasks.push(task);
    return task;
  };
  const agent = new Agent({
    instructions: 'support',
    tools: [
      tool({
        name: 'transfer',
        description: 'Transfer the caller.',
        execute: async () => {
          try {
            await createTask(depth).run();
          } catch (error) {
            result.resolve(error);
            throw error;
          }
        },
      }),
    ],
  });
  const llm = new FakeLLM([{ input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] }]);
  const chat = vi.spyOn(llm, 'chat');
  const session = new AgentSession({ llm });
  const resume = vi.spyOn(AgentActivity.prototype, 'resume');
  try {
    await session.start({ agent });
    session.generateReply({ userInput: 'transfer' });
    await entered.await;
    await session.close();

    expect(await result.await).toBeInstanceOf(ToolError);
    expect(resume).toHaveBeenCalledTimes(depth);
    expect(chat).toHaveBeenCalledOnce();
    expect(agent._agentActivity).toBeUndefined();
    for (const task of tasks) {
      expect(task.done).toBe(true);
      expect(task._agentActivity).toBeUndefined();
    }
  } finally {
    await session.close();
    resume.mockRestore();
    chat.mockRestore();
  }
});

it.each([
  { owner: 'onEnter', timing: 'queued' },
  { owner: 'tool', timing: 'queued' },
  { owner: 'onEnter', timing: 'draining' },
  { owner: 'tool', timing: 'draining' },
])(
  'closes the task and parent when updateAgent is $timing and the task owner is $owner',
  async ({ owner, timing }) => {
    const entered = new Future<void>();
    const exiting = new Future<void>();
    const finishExit = new Future<void>();
    const transfer = AgentTask.create<void>({
      instructions: 'transfer',
      onEnter: async () => {
        entered.resolve();
      },
      onExit: async () => {
        exiting.resolve();
        await finishExit.await;
      },
    });
    const result = new Future<unknown>();
    const runTransfer = async () => {
      try {
        await transfer.run();
      } catch (error) {
        result.resolve(error);
      }
    };
    class SupportAgent extends Agent {
      constructor() {
        super({
          instructions: 'support',
          tools: [
            tool({ name: 'transfer', description: 'Transfer the caller.', execute: runTransfer }),
          ],
        });
      }
      async onEnter() {
        if (owner === 'onEnter') await runTransfer();
      }
    }
    const agent = new SupportAgent();
    const fallback = new Agent({ instructions: 'fallback' });
    const session = new AgentSession({
      llm: new FakeLLM([{ input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] }]),
    });
    await session.start({ agent });
    if (owner === 'tool') session.generateReply({ userInput: 'transfer' });
    await entered.await;
    const taskActivity = transfer._agentActivity!;
    const closeTask = vi.spyOn(taskActivity, 'close');
    session.updateAgent(fallback);
    if (timing === 'draining') await exiting.await;
    const closing = session.close();
    finishExit.resolve();
    await closing;
    await (session as unknown as { updateActivityTask: { result: Promise<void> } })
      .updateActivityTask.result;

    expect(await result.await).toBeInstanceOf(ToolError);
    expect(closeTask).toHaveBeenCalled();
    expect(transfer._agentActivity).toBeUndefined();
    expect(agent._agentActivity).toBeUndefined();
    expect(fallback._agentActivity).toBeUndefined();
  },
  5_000,
);

it.each(['success', 'failure'] as const)(
  'resumes the parent after task onExit throws (result=%s)',
  async (outcome) => {
    const result = new Future<unknown>();
    const failure = new ToolError('task failed');
    const task = AgentTask.create<string>({
      instructions: 'finish the task',
      onEnter: () => task.complete(outcome === 'success' ? 'done' : failure),
      onExit: async () => {
        throw new Error('onExit failed');
      },
    });
    const answered = vi.fn();
    const agent = Agent.create({
      instructions: 'parent',
      tools: [
        tool({
          name: 'transfer',
          description: 'Run the task.',
          execute: async () => {
            try {
              const value = await task.run();
              result.resolve(value);
              return value;
            } catch (error) {
              result.resolve(error);
              throw error;
            }
          },
        }),
        tool({ name: 'answer', description: 'Answer the next turn.', execute: answered }),
      ],
    });
    const session = new AgentSession({
      llm: new FakeLLM([
        { input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] },
        { input: 'next turn', toolCalls: [{ name: 'answer', args: {} }] },
      ]),
      turnHandling: { turnDetection: 'manual' },
    });
    try {
      await session.start({ agent });
      const parentActivity = agent._agentActivity!;
      session.generateReply({ userInput: 'transfer' });
      expect(await result.await).toBe(outcome === 'success' ? 'done' : failure);
      expect(session._activity).toBe(parentActivity);
      expect(parentActivity.schedulingPaused).toBe(false);
      expect(task._agentActivity).toBeUndefined();
      await vi.waitFor(() => expect(parentActivity.currentSpeech).toBeUndefined());
      session.generateReply({ userInput: 'next turn' });
      await vi.waitFor(() => expect(answered).toHaveBeenCalledOnce());
    } finally {
      await session.close();
    }
  },
);

it('propagates onExit cancellation from drain', async () => {
  const cancellation = new Error('onExit cancelled');
  cancellation.name = 'AbortError';
  const onExit = vi.fn().mockImplementationOnce(() => {
    Task.current()!.cancel();
    throw cancellation;
  });
  const agent = Agent.create({ instructions: 'parent', onExit });
  const session = new AgentSession({ llm: new FakeLLM([]) });
  try {
    await session.start({ agent });
    const activity = agent._agentActivity!;
    await expect(activity.drain()).rejects.toBe(cancellation);
    expect(activity.schedulingPaused).toBe(false);
  } finally {
    await session.close();
  }
});
