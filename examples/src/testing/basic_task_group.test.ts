// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for basic_task_group.ts — a two-step onboarding flow (name, then email).
 *
 * Covers:
 *   - Each task in isolation
 *   - The full sequential TaskGroup flow
 *   - Regressions via out_of_scope (single, repeated, and cross-task)
 *   - onTaskCompleted callbacks and summarizeChatCtx
 *
 * Uses FakeLLM for deterministic, offline tests. Each FakeLLM response maps a
 * user input string to a canned tool call or text reply.
 *
 * The production agent starts its TaskGroup from a tool. The test harness does
 * not support nested session.run() calls, so we start the TaskGroup from
 * onEnter() instead. The task logic is identical to production.
 *
 * Best practices applied (see "Best practices for testing task groups" in docs):
 *   - 30s afterEach timeout (TaskGroup cleanup can be slow)
 *   - containsFunctionCall() over nextEvent() (resilient to multi-turn)
 *   - JSON.parse on function call args before asserting
 *   - No assertions on startup output (not captured in RunResult)
 *   - onEnter() signals readiness instead of awaiting generateReply()
 *   - Tasks tested in isolation and as a group
 */
import { Future, asError, beta, initializeLogger, llm, voice } from '@livekit/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const { TaskGroup } = beta;
type TaskGroupResult = beta.TaskGroupResult;
type TaskCompletedEvent = beta.TaskCompletedEvent;

initializeLogger({ pretty: true, level: 'warn' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `fn` and forward its result or error to `done`. */
async function withFutureResolution<T>(done: Future<T>, fn: () => Promise<T>): Promise<void> {
  try {
    done.resolve(await fn());
  } catch (error) {
    done.reject(asError(error));
  }
}

/** Create a FakeLLM that maps user input strings to canned responses. */
function createFakeLLM(responses: voice.testing.FakeLLMResponse[] = []): voice.testing.FakeLLM {
  return new voice.testing.FakeLLM(responses);
}

/** Send user input and wait for the run to finish. */
async function runAndWait(session: voice.AgentSession, userInput: string) {
  const result = session.run({ userInput });
  await result.wait();
  return result;
}

// ---------------------------------------------------------------------------
// Task classes (mirrors basic_task_group.ts)
//
// In production, onEnter() calls generateReply() to prompt the user. In tests
// we replace that with a ready signal so the test knows when to call
// session.run(). We use a holder object ({ current: Future }) so regression
// tests can swap in a fresh Future between steps — new task instances created
// on regression will read the updated holder.current.
// ---------------------------------------------------------------------------

interface ReadyHolder {
  current: Future<void>;
}

class CollectNameTask extends voice.AgentTask<string> {
  private readonly ready: ReadyHolder;

  constructor(ready: ReadyHolder) {
    super({
      instructions:
        'Collect the user name from the latest user message. As soon as you have it, call save_name.',
      tools: {
        save_name: llm.tool({
          description: 'Save the user name.',
          parameters: z.object({ name: z.string().describe('The user name') }),
          execute: async ({ name }) => {
            this.complete(name);
            return `Saved name: ${name}`;
          },
        }),
      },
    });
    this.ready = ready;
  }

  async onEnter() {
    this.ready.current.resolve();
  }
}

class CollectEmailTask extends voice.AgentTask<string> {
  private readonly ready: ReadyHolder;

  constructor(ready: ReadyHolder) {
    super({
      instructions:
        'Collect the user email from the latest user message. As soon as you have it, call save_email.',
      tools: {
        save_email: llm.tool({
          description: 'Save the user email.',
          parameters: z.object({ email: z.string().describe('The user email') }),
          execute: async ({ email }) => {
            this.complete(email);
            return `Saved email: ${email}`;
          },
        }),
      },
    });
    this.ready = ready;
  }

  async onEnter() {
    this.ready.current.resolve();
  }
}

// ---------------------------------------------------------------------------
// Parent agent factory — starts a TaskGroup with the two tasks above.
// ---------------------------------------------------------------------------

function createOnboardingAgent(opts: {
  done: Future<TaskGroupResult>;
  nameReady: ReadyHolder;
  emailReady: ReadyHolder;
  summarizeChatCtx?: boolean;
  onTaskCompleted?: (event: TaskCompletedEvent) => Promise<void>;
}) {
  return class OnboardingAgent extends voice.Agent {
    constructor() {
      super({ instructions: 'You are an onboarding assistant.' });
    }

    async onEnter() {
      await withFutureResolution(opts.done, async () => {
        const tg = new TaskGroup({
          summarizeChatCtx: opts.summarizeChatCtx ?? false,
          onTaskCompleted: opts.onTaskCompleted,
        });

        tg.add(() => new CollectNameTask(opts.nameReady), {
          id: 'name_task',
          description: 'Collect user name',
        });
        tg.add(() => new CollectEmailTask(opts.emailReady), {
          id: 'email_task',
          description: 'Collect user email',
        });

        return tg.run();
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('basic_task_group', { timeout: 120_000 }, () => {
  const sessions: voice.AgentSession[] = [];

  // 30s timeout — TaskGroup cleanup can be slow mid-flow.
  afterEach(async () => {
    await Promise.allSettled(sessions.map((s) => s.close()));
    sessions.length = 0;
  }, 30_000);

  async function startSession(agent: voice.Agent, options?: { llm?: llm.LLM }) {
    const session = new voice.AgentSession({ llm: options?.llm });
    sessions.push(session);
    await session.start({ agent });
    return session;
  }

  // -----------------------------------------------------------------------
  // Isolated task tests — one task per test, wrapped in a thin parent agent.
  // -----------------------------------------------------------------------

  describe('CollectNameTask (isolated)', () => {
    it('completes with the provided name when save_name is called', async () => {
      const done = new Future<string>();
      const ready: ReadyHolder = { current: new Future<void>() };

      class ParentAgent extends voice.Agent {
        constructor() {
          super({ instructions: 'Parent agent that runs CollectNameTask.' });
        }
        async onEnter() {
          await withFutureResolution(done, async () => new CollectNameTask(ready).run());
        }
      }

      const fakeLLM = createFakeLLM([
        { input: 'My name is Eve.', toolCalls: [{ name: 'save_name', args: { name: 'Eve' } }] },
      ]);

      const session = await startSession(new ParentAgent(), { llm: fakeLLM });
      await ready.current.await;

      const result = await runAndWait(session, 'My name is Eve.');
      result.expect.containsFunctionCall({ name: 'save_name' });

      // Args are raw JSON — parse before asserting.
      const args = JSON.parse(
        result.expect.containsFunctionCall({ name: 'save_name' }).event().item.args,
      );
      expect(args.name).toBe('Eve');

      await expect(done.await).resolves.toBe('Eve');
    });

    it('returns the tool output confirming the saved name', async () => {
      const done = new Future<string>();
      const ready: ReadyHolder = { current: new Future<void>() };

      class ParentAgent extends voice.Agent {
        constructor() {
          super({ instructions: 'Parent agent that runs CollectNameTask.' });
        }
        async onEnter() {
          await withFutureResolution(done, async () => new CollectNameTask(ready).run());
        }
      }

      const fakeLLM = createFakeLLM([
        { input: 'Call me Frank.', toolCalls: [{ name: 'save_name', args: { name: 'Frank' } }] },
      ]);

      const session = await startSession(new ParentAgent(), { llm: fakeLLM });
      await ready.current.await;

      const result = await runAndWait(session, 'Call me Frank.');
      result.expect.containsFunctionCallOutput({});

      await done.await;
    });
  });

  describe('CollectEmailTask (isolated)', () => {
    it('completes with the provided email when save_email is called', async () => {
      const done = new Future<string>();
      const ready: ReadyHolder = { current: new Future<void>() };

      class ParentAgent extends voice.Agent {
        constructor() {
          super({ instructions: 'Parent agent that runs CollectEmailTask.' });
        }
        async onEnter() {
          await withFutureResolution(done, async () => new CollectEmailTask(ready).run());
        }
      }

      const fakeLLM = createFakeLLM([
        {
          input: 'eve@example.com',
          toolCalls: [{ name: 'save_email', args: { email: 'eve@example.com' } }],
        },
      ]);

      const session = await startSession(new ParentAgent(), { llm: fakeLLM });
      await ready.current.await;

      const result = await runAndWait(session, 'eve@example.com');
      result.expect.containsFunctionCall({ name: 'save_email' });

      const args = JSON.parse(
        result.expect.containsFunctionCall({ name: 'save_email' }).event().item.args,
      );
      expect(args.email).toBe('eve@example.com');

      await expect(done.await).resolves.toBe('eve@example.com');
    });

    it('returns the tool output confirming the saved email', async () => {
      const done = new Future<string>();
      const ready: ReadyHolder = { current: new Future<void>() };

      class ParentAgent extends voice.Agent {
        constructor() {
          super({ instructions: 'Parent agent that runs CollectEmailTask.' });
        }
        async onEnter() {
          await withFutureResolution(done, async () => new CollectEmailTask(ready).run());
        }
      }

      const fakeLLM = createFakeLLM([
        {
          input: 'frank@test.org',
          toolCalls: [{ name: 'save_email', args: { email: 'frank@test.org' } }],
        },
      ]);

      const session = await startSession(new ParentAgent(), { llm: fakeLLM });
      await ready.current.await;

      const result = await runAndWait(session, 'frank@test.org');
      result.expect.containsFunctionCallOutput({});

      await done.await;
    });
  });

  // -----------------------------------------------------------------------
  // TaskGroup flow tests
  //
  // Each test follows this rhythm:
  //   1. await ready  — wait for the task to enter
  //   2. session.run  — provide user input
  //   3. await ready  — wait for the next task
  //   4. repeat until done
  //
  // Before regressions, reset the holder: nameReady.current = new Future()
  // so the new task instance created on regression has a fresh Future.
  // -----------------------------------------------------------------------

  describe('TaskGroup flow', () => {
    it('collects name then email sequentially', async () => {
      const done = new Future<TaskGroupResult>();
      const completedTaskIds: string[] = [];
      const nameReady: ReadyHolder = { current: new Future<void>() };
      const emailReady: ReadyHolder = { current: new Future<void>() };

      const Agent = createOnboardingAgent({
        done,
        nameReady,
        emailReady,
        onTaskCompleted: async ({ taskId }) => {
          completedTaskIds.push(taskId);
        },
      });

      const fakeLLM = createFakeLLM([
        { input: 'My name is Alice.', toolCalls: [{ name: 'save_name', args: { name: 'Alice' } }] },
        {
          input: 'alice@example.com',
          toolCalls: [{ name: 'save_email', args: { email: 'alice@example.com' } }],
        },
      ]);

      const session = await startSession(new Agent(), { llm: fakeLLM });
      await nameReady.current.await;

      const nameResult = await runAndWait(session, 'My name is Alice.');
      nameResult.expect.containsFunctionCall({ name: 'save_name' });
      const nameArgs = JSON.parse(
        nameResult.expect.containsFunctionCall({ name: 'save_name' }).event().item.args,
      );
      expect(nameArgs.name).toBe('Alice');

      await emailReady.current.await;

      const emailResult = await runAndWait(session, 'alice@example.com');
      emailResult.expect.containsFunctionCall({ name: 'save_email' });
      const emailArgs = JSON.parse(
        emailResult.expect.containsFunctionCall({ name: 'save_email' }).event().item.args,
      );
      expect(emailArgs.email).toBe('alice@example.com');

      const tgResult = await done.await;
      expect(tgResult.taskResults['name_task']).toBe('Alice');
      expect(tgResult.taskResults['email_task']).toBe('alice@example.com');
      expect(completedTaskIds).toEqual(['name_task', 'email_task']);
    });

    it('onTaskCompleted callback fires with correct task IDs and results', async () => {
      const done = new Future<TaskGroupResult>();
      const callbackLog: { taskId: string; result: unknown }[] = [];
      const nameReady: ReadyHolder = { current: new Future<void>() };
      const emailReady: ReadyHolder = { current: new Future<void>() };

      const Agent = createOnboardingAgent({
        done,
        nameReady,
        emailReady,
        onTaskCompleted: async (event) => {
          callbackLog.push({ taskId: event.taskId, result: event.result });
        },
      });

      const fakeLLM = createFakeLLM([
        { input: 'Name is Dana.', toolCalls: [{ name: 'save_name', args: { name: 'Dana' } }] },
        {
          input: 'dana@test.com',
          toolCalls: [{ name: 'save_email', args: { email: 'dana@test.com' } }],
        },
      ]);

      const session = await startSession(new Agent(), { llm: fakeLLM });
      await nameReady.current.await;

      await runAndWait(session, 'Name is Dana.');
      await emailReady.current.await;

      await runAndWait(session, 'dana@test.com');
      await done.await;

      expect(callbackLog).toHaveLength(2);
      expect(callbackLog[0]).toEqual({ taskId: 'name_task', result: 'Dana' });
      expect(callbackLog[1]).toEqual({ taskId: 'email_task', result: 'dana@test.com' });
    });

    it('summarizeChatCtx produces a summary after all tasks complete', async () => {
      const done = new Future<TaskGroupResult>();
      const nameReady: ReadyHolder = { current: new Future<void>() };
      const emailReady: ReadyHolder = { current: new Future<void>() };

      const Agent = createOnboardingAgent({
        done,
        nameReady,
        emailReady,
        summarizeChatCtx: true,
      });

      // Third response handles the summarisation request sent after all tasks complete.
      const fakeLLM = createFakeLLM([
        {
          input: 'My name is Charlie.',
          toolCalls: [{ name: 'save_name', args: { name: 'Charlie' } }],
        },
        {
          input: 'charlie@test.com',
          toolCalls: [{ name: 'save_email', args: { email: 'charlie@test.com' } }],
        },
        {
          input: 'Conversation to summarize:\n\nuser: My name is Charlie.\nuser: charlie@test.com',
          content: 'Summary: name=Charlie, email=charlie@test.com.',
        },
      ]);

      const session = await startSession(new Agent(), { llm: fakeLLM });
      await nameReady.current.await;

      await runAndWait(session, 'My name is Charlie.');
      await emailReady.current.await;

      await runAndWait(session, 'charlie@test.com');

      const tgResult = await done.await;
      expect(tgResult.taskResults['name_task']).toBe('Charlie');
      expect(tgResult.taskResults['email_task']).toBe('charlie@test.com');

      // summarizeChatCtx condenses the conversation into a single summary message.
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

  // -----------------------------------------------------------------------
  // Regression tests — out_of_scope lets the user revisit completed tasks.
  //
  // out_of_scope can only be called from the currently active task. It
  // re-queues the target task(s) and the current task, then re-executes
  // them in order. It cannot be called after all tasks have finished.
  // -----------------------------------------------------------------------

  describe('TaskGroup regressions', () => {
    it('single regression lets user correct a previous task', async () => {
      // name("Alice") -> regress -> name("Bob") -> email -> done
      const done = new Future<TaskGroupResult>();
      const nameReady: ReadyHolder = { current: new Future<void>() };
      const emailReady: ReadyHolder = { current: new Future<void>() };

      const Agent = createOnboardingAgent({ done, nameReady, emailReady });

      const fakeLLM = createFakeLLM([
        { input: 'My name is Alice.', toolCalls: [{ name: 'save_name', args: { name: 'Alice' } }] },
        {
          input: 'Wait, I want to change my name to Bob.',
          toolCalls: [{ name: 'out_of_scope', args: { task_ids: ['name_task'] } }],
        },
        { input: 'My name is Bob.', toolCalls: [{ name: 'save_name', args: { name: 'Bob' } }] },
        {
          input: 'bob@example.com',
          toolCalls: [{ name: 'save_email', args: { email: 'bob@example.com' } }],
        },
      ]);

      const session = await startSession(new Agent(), { llm: fakeLLM });
      await nameReady.current.await;

      // Complete name_task.
      nameReady.current = new Future<void>();
      let result = await runAndWait(session, 'My name is Alice.');
      result.expect.containsFunctionCall({ name: 'save_name' });
      await emailReady.current.await;

      // Regress — out_of_scope causes run() to reject with OutOfScopeError.
      nameReady.current = new Future<void>();
      const regressResult = session.run({ userInput: 'Wait, I want to change my name to Bob.' });
      await expect(regressResult.wait()).rejects.toThrow('out_of_scope');
      regressResult.expect.containsFunctionCall({ name: 'out_of_scope' });
      await nameReady.current.await;

      // Provide corrected name.
      emailReady.current = new Future<void>();
      result = await runAndWait(session, 'My name is Bob.');
      const nameArgs = JSON.parse(
        result.expect.containsFunctionCall({ name: 'save_name' }).event().item.args,
      );
      expect(nameArgs.name).toBe('Bob');
      await emailReady.current.await;

      // Complete email.
      result = await runAndWait(session, 'bob@example.com');
      result.expect.containsFunctionCall({ name: 'save_email' });

      const tgResult = await done.await;
      expect((tgResult.taskResults['name_task'] as string).toLowerCase()).toContain('bob');
      expect(tgResult.taskResults['email_task']).toBe('bob@example.com');
    });

    it('multiple regressions to the same task converge on the final value', async () => {
      // name("Alice") -> regress -> name("Bob") -> regress -> name("Charlie") -> email -> done
      const done = new Future<TaskGroupResult>();
      const nameReady: ReadyHolder = { current: new Future<void>() };
      const emailReady: ReadyHolder = { current: new Future<void>() };

      const Agent = createOnboardingAgent({ done, nameReady, emailReady });

      const fakeLLM = createFakeLLM([
        { input: 'My name is Alice.', toolCalls: [{ name: 'save_name', args: { name: 'Alice' } }] },
        {
          input: 'Actually, change it to Bob.',
          toolCalls: [{ name: 'out_of_scope', args: { task_ids: ['name_task'] } }],
        },
        { input: 'My name is Bob.', toolCalls: [{ name: 'save_name', args: { name: 'Bob' } }] },
        {
          input: 'No wait, make it Charlie.',
          toolCalls: [{ name: 'out_of_scope', args: { task_ids: ['name_task'] } }],
        },
        {
          input: 'My name is Charlie.',
          toolCalls: [{ name: 'save_name', args: { name: 'Charlie' } }],
        },
        {
          input: 'charlie@example.com',
          toolCalls: [{ name: 'save_email', args: { email: 'charlie@example.com' } }],
        },
      ]);

      const session = await startSession(new Agent(), { llm: fakeLLM });
      await nameReady.current.await;

      nameReady.current = new Future<void>();
      await runAndWait(session, 'My name is Alice.');
      await emailReady.current.await;

      // First regression.
      nameReady.current = new Future<void>();
      const regress1 = session.run({ userInput: 'Actually, change it to Bob.' });
      await expect(regress1.wait()).rejects.toThrow('out_of_scope');
      await nameReady.current.await;

      emailReady.current = new Future<void>();
      await runAndWait(session, 'My name is Bob.');
      await emailReady.current.await;

      // Second regression.
      nameReady.current = new Future<void>();
      const regress2 = session.run({ userInput: 'No wait, make it Charlie.' });
      await expect(regress2.wait()).rejects.toThrow('out_of_scope');
      await nameReady.current.await;

      emailReady.current = new Future<void>();
      await runAndWait(session, 'My name is Charlie.');
      await emailReady.current.await;

      await runAndWait(session, 'charlie@example.com');

      // Only the last value sticks.
      const tgResult = await done.await;
      expect((tgResult.taskResults['name_task'] as string).toLowerCase()).toContain('charlie');
      expect(tgResult.taskResults['email_task']).toBe('charlie@example.com');
    });

    it('regression from email_task replays name_task then email_task', async () => {
      // name("Alice") -> email starts -> regress to name -> name("Dana") -> email("dana") -> done
      //
      // Regressing from email_task re-queues both name_task (target) and
      // email_task (current), so both replay in order.
      const done = new Future<TaskGroupResult>();
      const completedTaskIds: string[] = [];
      const nameReady: ReadyHolder = { current: new Future<void>() };
      const emailReady: ReadyHolder = { current: new Future<void>() };

      const Agent = createOnboardingAgent({
        done,
        nameReady,
        emailReady,
        onTaskCompleted: async ({ taskId }) => {
          completedTaskIds.push(taskId);
        },
      });

      const fakeLLM = createFakeLLM([
        { input: 'My name is Alice.', toolCalls: [{ name: 'save_name', args: { name: 'Alice' } }] },
        {
          input: 'I need to start over with a different name.',
          toolCalls: [{ name: 'out_of_scope', args: { task_ids: ['name_task'] } }],
        },
        { input: 'My name is Dana.', toolCalls: [{ name: 'save_name', args: { name: 'Dana' } }] },
        {
          input: 'dana@test.com',
          toolCalls: [{ name: 'save_email', args: { email: 'dana@test.com' } }],
        },
      ]);

      const session = await startSession(new Agent(), { llm: fakeLLM });
      await nameReady.current.await;

      nameReady.current = new Future<void>();
      await runAndWait(session, 'My name is Alice.');
      await emailReady.current.await;

      // Regress from email_task back to name_task.
      nameReady.current = new Future<void>();
      const regressResult = session.run({
        userInput: 'I need to start over with a different name.',
      });
      await expect(regressResult.wait()).rejects.toThrow('out_of_scope');
      regressResult.expect.containsFunctionCall({ name: 'out_of_scope' });

      const oosArgs = JSON.parse(
        regressResult.expect.containsFunctionCall({ name: 'out_of_scope' }).event().item.args,
      );
      expect(oosArgs.task_ids).toEqual(['name_task']);
      await nameReady.current.await;

      // Re-collect name, then email replays automatically.
      emailReady.current = new Future<void>();
      await runAndWait(session, 'My name is Dana.');
      await emailReady.current.await;

      await runAndWait(session, 'dana@test.com');

      const tgResult = await done.await;
      expect(tgResult.taskResults['name_task']).toBe('Dana');
      expect(tgResult.taskResults['email_task']).toBe('dana@test.com');

      // Callback fires for every completion, including replays.
      expect(completedTaskIds).toEqual(['name_task', 'name_task', 'email_task']);
    });
  });
});
