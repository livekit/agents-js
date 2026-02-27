// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Future, beta, initializeLogger, llm, voice } from '@livekit/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const { TaskGroup } = beta;
type TaskGroupResult = beta.TaskGroupResult;
type TaskCompletedEvent = beta.TaskCompletedEvent;

initializeLogger({ pretty: true, level: 'warn' });

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withFutureResolution<T>(done: Future<T>, fn: () => Promise<T>): Promise<void> {
  try {
    done.resolve(await fn());
  } catch (error) {
    done.reject(asError(error));
  }
}

function createFakeLLM(responses: voice.testing.FakeLLMResponse[] = []): voice.testing.FakeLLM {
  return new voice.testing.FakeLLM(responses);
}

async function runAndWait(session: voice.AgentSession, userInput: string) {
  const result = session.run({ userInput });
  await result.wait();
  return result;
}

describe('TaskGroup', { timeout: 120_000 }, () => {
  const sessions: voice.AgentSession[] = [];

  afterEach(async () => {
    await Promise.allSettled(sessions.map((s) => s.close()));
    sessions.length = 0;
  });

  async function startSession(agent: voice.Agent, options?: { llm?: llm.LLM }) {
    const session = new voice.AgentSession({ llm: options?.llm });
    sessions.push(session);
    await session.start({ agent });
    return session;
  }

  it('sequential tasks complete in order', async () => {
    const done = new Future<TaskGroupResult>();
    const executionOrder: string[] = [];

    class TaskA extends voice.AgentTask<string> {
      constructor() {
        super({ instructions: 'Task A' });
      }
      async onEnter() {
        executionOrder.push('a');
        this.complete('result-a');
      }
    }

    class TaskB extends voice.AgentTask<number> {
      constructor() {
        super({ instructions: 'Task B' });
      }
      async onEnter() {
        executionOrder.push('b');
        this.complete(42);
      }
    }

    class TaskC extends voice.AgentTask<boolean> {
      constructor() {
        super({ instructions: 'Task C' });
      }
      async onEnter() {
        executionOrder.push('c');
        this.complete(true);
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'Orchestrates TaskGroup test.' });
      }

      async onEnter() {
        await withFutureResolution(done, async () => {
          const tg = new TaskGroup({ summarizeChatCtx: false });
          tg.add(() => new TaskA(), { id: 'a', description: 'Task A' });
          tg.add(() => new TaskB(), { id: 'b', description: 'Task B' });
          tg.add(() => new TaskC(), { id: 'c', description: 'Task C' });
          return tg.run();
        });
      }
    }

    await startSession(new ParentAgent());
    const result = await done.await;

    expect(result.taskResults).toEqual({
      a: 'result-a',
      b: 42,
      c: true,
    });
    expect(executionOrder).toEqual(['a', 'b', 'c']);
  });

  it('onTaskCompleted callback fires for each task', async () => {
    const done = new Future<TaskGroupResult>();
    const callbackLog: { taskId: string; result: unknown }[] = [];

    class AlphaTask extends voice.AgentTask<string> {
      constructor() {
        super({ instructions: 'Alpha' });
      }
      async onEnter() {
        this.complete('alpha-val');
      }
    }

    class BetaTask extends voice.AgentTask<number> {
      constructor() {
        super({ instructions: 'Beta' });
      }
      async onEnter() {
        this.complete(99);
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'Callback test agent.' });
      }

      async onEnter() {
        await withFutureResolution(done, async () => {
          const tg = new TaskGroup({
            summarizeChatCtx: false,
            onTaskCompleted: async (event: TaskCompletedEvent) => {
              callbackLog.push({ taskId: event.taskId, result: event.result });
            },
          });
          tg.add(() => new AlphaTask(), { id: 'alpha', description: 'Alpha task' });
          tg.add(() => new BetaTask(), { id: 'beta', description: 'Beta task' });
          return tg.run();
        });
      }
    }

    await startSession(new ParentAgent());
    await done.await;

    expect(callbackLog).toHaveLength(2);
    expect(callbackLog[0]).toEqual({ taskId: 'alpha', result: 'alpha-val' });
    expect(callbackLog[1]).toEqual({ taskId: 'beta', result: 99 });
  });

  it('returnExceptions: true captures errors in results', async () => {
    const done = new Future<TaskGroupResult>();

    class GoodTask extends voice.AgentTask<string> {
      constructor() {
        super({ instructions: 'Succeeds.' });
      }
      async onEnter() {
        this.complete('ok');
      }
    }

    class BadTask extends voice.AgentTask<string> {
      constructor() {
        super({ instructions: 'Fails.' });
      }
      async onEnter() {
        this.complete(new Error('task-failure'));
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'Error capture test.' });
      }

      async onEnter() {
        await withFutureResolution(done, async () => {
          const tg = new TaskGroup({
            summarizeChatCtx: false,
            returnExceptions: true,
          });
          tg.add(() => new GoodTask(), { id: 'good', description: 'Succeeds' });
          tg.add(() => new BadTask(), { id: 'bad', description: 'Fails' });
          return tg.run();
        });
      }
    }

    await startSession(new ParentAgent());
    const result = await done.await;

    expect(result.taskResults['good']).toBe('ok');
    expect(result.taskResults['bad']).toBeInstanceOf(Error);
    expect((result.taskResults['bad'] as Error).message).toBe('task-failure');
  });

  it('returnExceptions: false propagates error and stops', async () => {
    const done = new Future<TaskGroupResult>();
    let secondTaskRan = false;

    class FailingTask extends voice.AgentTask<string> {
      constructor() {
        super({ instructions: 'Fails immediately.' });
      }
      async onEnter() {
        this.complete(new Error('propagated-error'));
      }
    }

    class NeverReachedTask extends voice.AgentTask<string> {
      constructor() {
        super({ instructions: 'Should not run.' });
      }
      async onEnter() {
        secondTaskRan = true;
        this.complete('unreachable');
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'Error propagation test.' });
      }

      async onEnter() {
        await withFutureResolution(done, async () => {
          const tg = new TaskGroup({
            summarizeChatCtx: false,
            returnExceptions: false,
          });
          tg.add(() => new FailingTask(), { id: 'fail', description: 'Fails' });
          tg.add(() => new NeverReachedTask(), { id: 'never', description: 'Never reached' });
          return tg.run();
        });
      }
    }

    await startSession(new ParentAgent());
    await expect(done.await).rejects.toThrow('propagated-error');
    expect(secondTaskRan).toBe(false);
  });

  it('LLM-powered regression via out_of_scope', async () => {
    const done = new Future<TaskGroupResult>();
    let taskReady = new Future<void>();

    class CollectNameTask extends voice.AgentTask<string> {
      constructor() {
        super({
          instructions:
            'Extract the user name from the latest user message. Call recordName immediately.',
          tools: {
            recordName: llm.tool({
              description: 'Record the user name',
              parameters: z.object({ name: z.string().describe('The user name') }),
              execute: async ({ name }) => {
                this.complete(name);
                return 'recorded';
              },
            }),
          },
        });
      }

      async onEnter() {
        taskReady.resolve();
      }
    }

    class CollectEmailTask extends voice.AgentTask<string> {
      constructor() {
        super({
          instructions:
            'Extract an email address from the latest user message. Call recordEmail immediately.',
          tools: {
            recordEmail: llm.tool({
              description: 'Record the user email',
              parameters: z.object({ email: z.string().describe('The email address') }),
              execute: async ({ email }) => {
                this.complete(email);
                return 'recorded';
              },
            }),
          },
        });
      }

      async onEnter() {
        taskReady.resolve();
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'TaskGroup regression test parent.' });
      }

      async onEnter() {
        await withFutureResolution(done, async () => {
          const tg = new TaskGroup({ summarizeChatCtx: false });
          tg.add(() => new CollectNameTask(), {
            id: 'name_task',
            description: 'Collects the user name',
          });
          tg.add(() => new CollectEmailTask(), {
            id: 'email_task',
            description: 'Collects the user email',
          });
          return tg.run();
        });
      }
    }

    const llmModel = createFakeLLM([
      {
        input: 'My name is Alice.',
        toolCalls: [{ name: 'recordName', args: { name: 'Alice' } }],
      },
      {
        input: 'Actually, I want to change my name to Bob.',
        toolCalls: [{ name: 'out_of_scope', args: { task_ids: ['name_task'] } }],
      },
      {
        input: 'My name is Bob.',
        toolCalls: [{ name: 'recordName', args: { name: 'Bob' } }],
      },
      {
        input: 'My email is bob@test.com',
        toolCalls: [{ name: 'recordEmail', args: { email: 'bob@test.com' } }],
      },
    ]);
    const session = await startSession(new ParentAgent(), { llm: llmModel });
    await taskReady.await;

    taskReady = new Future<void>();
    let result = await runAndWait(session, 'My name is Alice.');
    result.expect.containsFunctionCall({ name: 'recordName' });
    await taskReady.await;

    taskReady = new Future<void>();
    const regressResult = session.run({ userInput: 'Actually, I want to change my name to Bob.' });
    await expect(regressResult.wait()).rejects.toThrow('out_of_scope');
    regressResult.expect.containsFunctionCall({ name: 'out_of_scope' });
    await taskReady.await;

    taskReady = new Future<void>();
    result = await runAndWait(session, 'My name is Bob.');
    result.expect.containsFunctionCall({ name: 'recordName' });
    await taskReady.await;

    result = await runAndWait(session, 'My email is bob@test.com');
    result.expect.containsFunctionCall({ name: 'recordEmail' });

    const tgResult = await done.await;
    expect(tgResult.taskResults['name_task']).toBeDefined();
    expect(tgResult.taskResults['email_task']).toBeDefined();
    expect((tgResult.taskResults['name_task'] as string).toLowerCase()).toContain('bob');
  });

  it('summarizeChatCtx condenses history', async () => {
    const done = new Future<TaskGroupResult>();
    let taskReady = new Future<void>();

    class ChattyTaskA extends voice.AgentTask<string> {
      constructor() {
        super({
          instructions:
            'Extract the user favorite color from the latest message. Call recordColor immediately.',
          tools: {
            recordColor: llm.tool({
              description: 'Record favorite color',
              parameters: z.object({ color: z.string() }),
              execute: async ({ color }) => {
                this.complete(color);
                return 'recorded';
              },
            }),
          },
        });
      }

      async onEnter() {
        taskReady.resolve();
      }
    }

    class ChattyTaskB extends voice.AgentTask<string> {
      constructor() {
        super({
          instructions:
            'Extract the user favorite food from the latest message. Call recordFood immediately.',
          tools: {
            recordFood: llm.tool({
              description: 'Record favorite food',
              parameters: z.object({ food: z.string() }),
              execute: async ({ food }) => {
                this.complete(food);
                return 'recorded';
              },
            }),
          },
        });
      }

      async onEnter() {
        taskReady.resolve();
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'Summarize test parent.' });
      }

      async onEnter() {
        await withFutureResolution(done, async () => {
          const tg = new TaskGroup({ summarizeChatCtx: true });
          tg.add(() => new ChattyTaskA(), {
            id: 'color',
            description: 'Collects favorite color',
          });
          tg.add(() => new ChattyTaskB(), {
            id: 'food',
            description: 'Collects favorite food',
          });
          return tg.run();
        });
      }
    }

    const llmModel = createFakeLLM([
      {
        input: 'Blue is my favorite color.',
        toolCalls: [{ name: 'recordColor', args: { color: 'Blue' } }],
      },
      {
        input: 'I love pizza.',
        toolCalls: [{ name: 'recordFood', args: { food: 'pizza' } }],
      },
      {
        input:
          'Conversation to summarize:\n\nuser: Blue is my favorite color.\nuser: I love pizza.',
        content: 'Summary: color=Blue, food=pizza.',
      },
    ]);

    const session = await startSession(new ParentAgent(), { llm: llmModel });
    await taskReady.await;

    taskReady = new Future<void>();
    await runAndWait(session, 'Blue is my favorite color.');
    await taskReady.await;

    await runAndWait(session, 'I love pizza.');

    const tgResult = await done.await;
    expect(tgResult.taskResults['color']).toBeDefined();
    expect(tgResult.taskResults['food']).toBeDefined();

    const items = session.currentAgent.chatCtx.items;
    const summaryMsg = items.find(
      (item) =>
        item.type === 'message' && item.role === 'assistant' && item.extra?.is_summary === true,
    );
    expect(summaryMsg).toBeDefined();
    if (summaryMsg && summaryMsg.type === 'message') {
      expect(summaryMsg.textContent).toContain('[history summary]');
    }
  });
});
