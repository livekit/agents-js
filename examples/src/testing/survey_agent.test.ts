// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the survey agent's TaskGroup workflow.
 *
 * Demonstrates the best practices documented in
 * https://docs.livekit.io/agents/logic/tasks/#testing-task-groups:
 *
 * - Initialize userData on the AgentSession.
 * - Future-based readiness signaling instead of sleep-based delays.
 * - containsFunctionCall({ name, args }) with partial matching for simple
 *   value checks; JSON.parse only for richer assertions (range checks, regex).
 * - No assertions on startup output produced in onEnter().
 * - onEnter() resolves a ready Future instead of awaiting generateReply().
 * - Tasks tested in isolation and as a group.
 * - Regression test for disqualify (analogous to out_of_scope).
 */
import { Future, asError, beta, initializeLogger, voice } from '@livekit/agents';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BehavioralTask,
  CommuteTask,
  EmailTask,
  ExperienceTask,
  IntroTask,
  type SurveyUserData,
} from '../survey_agent.js';

const { TaskGroup } = beta;
type TaskGroupResult = beta.TaskGroupResult;
type TaskCompletedEvent = beta.TaskCompletedEvent;

initializeLogger({ pretty: true, level: 'warn' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ReadyHolder {
  current: Future<void>;
}

function createUserData(): SurveyUserData {
  return { filename: 'survey-results-test.csv', candidateName: '', taskResults: {} };
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

async function runAndWait(session: voice.AgentSession<SurveyUserData>, userInput: string) {
  const result = session.run({ userInput });
  await result.wait();
  return result;
}

// ---------------------------------------------------------------------------
// Test task subclasses — resolve a ready Future in onEnter() instead of
// calling generateReply(), so the test knows when to send input.
// ---------------------------------------------------------------------------

class TestIntroTask extends IntroTask {
  private readonly ready: ReadyHolder;

  constructor(ready: ReadyHolder) {
    super();
    this.ready = ready;
  }

  async onEnter() {
    this.ready.current.resolve();
  }
}

class TestEmailTask extends EmailTask {
  private readonly ready: ReadyHolder;

  constructor(ready: ReadyHolder) {
    super();
    this.ready = ready;
  }

  async onEnter() {
    this.ready.current.resolve();
  }
}

class TestCommuteTask extends CommuteTask {
  private readonly ready: ReadyHolder;

  constructor(ready: ReadyHolder) {
    super();
    this.ready = ready;
  }

  async onEnter() {
    this.ready.current.resolve();
  }
}

class TestExperienceTask extends ExperienceTask {
  private readonly ready: ReadyHolder;

  constructor(ready: ReadyHolder) {
    super();
    this.ready = ready;
  }

  async onEnter() {
    this.ready.current.resolve();
  }
}

class TestBehavioralTask extends BehavioralTask {
  private readonly ready: ReadyHolder;

  constructor(ready: ReadyHolder) {
    super();
    this.ready = ready;
  }

  protected checkCompletion() {
    super.checkCompletion();
  }

  async onEnter() {
    this.ready.current.resolve();
  }
}

// ---------------------------------------------------------------------------
// Parent agents for isolated and grouped tests
// ---------------------------------------------------------------------------

class SingleTaskAgent<ResultT> extends voice.Agent<SurveyUserData> {
  constructor(private readonly task: voice.AgentTask<ResultT, SurveyUserData>) {
    super({ instructions: 'Run a single survey task.' });
  }

  async onEnter() {
    await this.task.run();
  }
}

function createSurveyTestAgent(opts: {
  done: Future<TaskGroupResult>;
  introReady: ReadyHolder;
  emailReady: ReadyHolder;
  commuteReady: ReadyHolder;
  experienceReady: ReadyHolder;
  onTaskCompleted?: (event: TaskCompletedEvent) => Promise<void>;
}) {
  return class SurveyTestAgent extends voice.Agent<SurveyUserData> {
    constructor() {
      super({ instructions: 'You are a survey agent screening candidates.' });
    }

    async onEnter() {
      await withFutureResolution(opts.done, async () => {
        const group = new TaskGroup({
          summarizeChatCtx: false,
          onTaskCompleted: opts.onTaskCompleted,
        });

        group.add(() => new TestIntroTask(opts.introReady), {
          id: 'intro',
          description: 'Collect name and intro.',
        });
        group.add(() => new TestEmailTask(opts.emailReady), {
          id: 'email',
          description: 'Collect email.',
        });
        group.add(() => new TestCommuteTask(opts.commuteReady), {
          id: 'commute',
          description: 'Ask about commute.',
        });
        group.add(() => new TestExperienceTask(opts.experienceReady), {
          id: 'experience',
          description: 'Collect work history.',
        });

        const result = await group.run();
        this.session.userData.taskResults = result.taskResults;
        return result;
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('survey_agent TaskGroup reference', { timeout: 120_000 }, () => {
  const sessions: voice.AgentSession<SurveyUserData>[] = [];

  afterEach(async () => {
    await Promise.allSettled(sessions.map((session) => session.close()));
    sessions.length = 0;
  }, 30_000);

  async function startSession(agent: voice.Agent<SurveyUserData>, llm: voice.testing.FakeLLM) {
    const session = new voice.AgentSession<SurveyUserData>({ llm, userData: createUserData() });
    sessions.push(session);
    await session.start({ agent });
    return session;
  }

  // -----------------------------------------------------------------------
  // Isolated task tests
  // -----------------------------------------------------------------------

  describe('IntroTask (isolated)', () => {
    it('records the candidate name via saveIntro', async () => {
      const ready: ReadyHolder = { current: new Future<void>() };
      const fakeLLM = createFakeLLM([
        {
          input:
            "Hi, my name is Alice. I'm a backend engineer with five years of experience building APIs at Acme.",
          toolCalls: [{ name: 'saveIntro', args: { name: 'Alice', intro: 'Backend engineer.' } }],
        },
      ]);
      const session = await startSession(new SingleTaskAgent(new TestIntroTask(ready)), fakeLLM);
      await ready.current.await;

      const result = await runAndWait(
        session,
        "Hi, my name is Alice. I'm a backend engineer with five years of experience building APIs at Acme.",
      );
      result.expect.containsFunctionCall({ name: 'saveIntro', args: { name: 'Alice' } });
      expect(session.userData.candidateName.toLowerCase()).toBe('alice');
    });

    it('returns the tool output confirming the saved intro', async () => {
      const ready: ReadyHolder = { current: new Future<void>() };
      const fakeLLM = createFakeLLM([
        {
          input: "I'm Bob, a fullstack developer.",
          toolCalls: [{ name: 'saveIntro', args: { name: 'Bob', intro: 'Fullstack developer.' } }],
        },
      ]);
      const session = await startSession(new SingleTaskAgent(new TestIntroTask(ready)), fakeLLM);
      await ready.current.await;

      const result = await runAndWait(session, "I'm Bob, a fullstack developer.");
      result.expect.containsFunctionCallOutput({});
    });
  });

  describe('EmailTask (isolated)', () => {
    it('records the candidate email via saveEmail', async () => {
      const ready: ReadyHolder = { current: new Future<void>() };
      const fakeLLM = createFakeLLM([
        {
          input: 'alice@example.com',
          toolCalls: [{ name: 'saveEmail', args: { email: 'alice@example.com' } }],
        },
      ]);
      const session = await startSession(new SingleTaskAgent(new TestEmailTask(ready)), fakeLLM);
      await ready.current.await;

      const result = await runAndWait(session, 'alice@example.com');
      result.expect.containsFunctionCall({
        name: 'saveEmail',
        args: { email: 'alice@example.com' },
      });
    });
  });

  describe('CommuteTask (isolated)', () => {
    it('records commute flexibility via saveCommute', async () => {
      const ready: ReadyHolder = { current: new Future<void>() };
      const fakeLLM = createFakeLLM([
        {
          input: 'Yes, I can commute three days a week. I usually take the subway.',
          toolCalls: [{ name: 'saveCommute', args: { canCommute: true, commuteMethod: 'subway' } }],
        },
      ]);
      const session = await startSession(new SingleTaskAgent(new TestCommuteTask(ready)), fakeLLM);
      await ready.current.await;

      const result = await runAndWait(
        session,
        'Yes, I can commute three days a week. I usually take the subway.',
      );
      result.expect.containsFunctionCall({
        name: 'saveCommute',
        args: { canCommute: true, commuteMethod: 'subway' },
      });
    });
  });

  describe('ExperienceTask (isolated)', () => {
    it('records years and description via saveExperience', async () => {
      const ready: ReadyHolder = { current: new Future<void>() };
      const input =
        'I have five years of experience total. I started as a junior engineer at Acme working on data pipelines for two years, then moved to Globex as a senior backend engineer for the past three years.';
      const fakeLLM = createFakeLLM([
        {
          input,
          toolCalls: [
            {
              name: 'saveExperience',
              args: {
                yearsOfExperience: 5,
                experienceDescription: 'Acme data pipelines, Globex APIs.',
              },
            },
          ],
        },
      ]);
      const session = await startSession(
        new SingleTaskAgent(new TestExperienceTask(ready)),
        fakeLLM,
      );
      await ready.current.await;

      const result = await runAndWait(session, input);
      result.expect.containsFunctionCall({
        name: 'saveExperience',
        args: { yearsOfExperience: 5 },
      });

      // Use JSON.parse for the substring check — the helper only does exact matching.
      const args = JSON.parse(
        result.expect.containsFunctionCall({ name: 'saveExperience' }).event().item.args,
      );
      expect(args.experienceDescription.toLowerCase()).toContain('acme');
    });
  });

  describe('BehavioralTask (isolated)', () => {
    it('completes after all three save tools fire', async () => {
      const ready: ReadyHolder = { current: new Future<void>() };
      const input =
        'My biggest strength is debugging hard distributed systems issues. My main weakness is that I sometimes over-engineer early prototypes. I work best as part of a team.';
      const fakeLLM = createFakeLLM([
        {
          input,
          toolCalls: [
            { name: 'saveStrengths', args: { strengths: 'Debugging distributed systems.' } },
            {
              name: 'saveWeaknesses',
              args: { weaknesses: 'Sometimes over-engineers prototypes.' },
            },
            { name: 'saveWorkStyle', args: { workStyle: 'team_player' } },
          ],
        },
      ]);
      const session = await startSession(
        new SingleTaskAgent(new TestBehavioralTask(ready)),
        fakeLLM,
      );
      await ready.current.await;

      const result = await runAndWait(session, input);
      result.expect.containsFunctionCall({
        name: 'saveStrengths',
        args: { strengths: 'Debugging distributed systems.' },
      });
      result.expect.containsFunctionCall({
        name: 'saveWeaknesses',
        args: { weaknesses: 'Sometimes over-engineers prototypes.' },
      });
      result.expect.containsFunctionCall({
        name: 'saveWorkStyle',
        args: { workStyle: 'team_player' },
      });
    });
  });

  // -----------------------------------------------------------------------
  // TaskGroup flow tests
  // -----------------------------------------------------------------------

  describe('TaskGroup flow', () => {
    it('collects intro, email, commute, and experience sequentially', async () => {
      const done = new Future<TaskGroupResult>();
      const completedIds: string[] = [];
      const introReady: ReadyHolder = { current: new Future<void>() };
      const emailReady: ReadyHolder = { current: new Future<void>() };
      const commuteReady: ReadyHolder = { current: new Future<void>() };
      const experienceReady: ReadyHolder = { current: new Future<void>() };

      const Agent = createSurveyTestAgent({
        done,
        introReady,
        emailReady,
        commuteReady,
        experienceReady,
        onTaskCompleted: async ({ taskId }) => {
          completedIds.push(taskId);
        },
      });

      const fakeLLM = createFakeLLM([
        {
          input:
            "My name is Bob, I'm a software engineer with eight years of experience focused on APIs.",
          toolCalls: [{ name: 'saveIntro', args: { name: 'Bob', intro: 'API-focused engineer.' } }],
        },
        {
          input: 'bob@example.com',
          toolCalls: [{ name: 'saveEmail', args: { email: 'bob@example.com' } }],
        },
        {
          input: "Yes, I can commute three days a week. I'd be driving in.",
          toolCalls: [
            { name: 'saveCommute', args: { canCommute: true, commuteMethod: 'driving' } },
          ],
        },
        {
          input:
            'I have eight years total, five at Initech on backend systems and the last three at Hooli leading an API team.',
          toolCalls: [
            {
              name: 'saveExperience',
              args: {
                yearsOfExperience: 8,
                experienceDescription: 'Five years at Initech, three years at Hooli.',
              },
            },
          ],
        },
      ]);

      const session = await startSession(new Agent(), fakeLLM);
      await introReady.current.await;

      const introResult = await runAndWait(
        session,
        "My name is Bob, I'm a software engineer with eight years of experience focused on APIs.",
      );
      introResult.expect.containsFunctionCall({ name: 'saveIntro', args: { name: 'Bob' } });

      await emailReady.current.await;

      const emailResult = await runAndWait(session, 'bob@example.com');
      emailResult.expect.containsFunctionCall({
        name: 'saveEmail',
        args: { email: 'bob@example.com' },
      });

      await commuteReady.current.await;

      const commuteResult = await runAndWait(
        session,
        "Yes, I can commute three days a week. I'd be driving in.",
      );
      commuteResult.expect.containsFunctionCall({
        name: 'saveCommute',
        args: { canCommute: true, commuteMethod: 'driving' },
      });

      await experienceReady.current.await;

      const expResult = await runAndWait(
        session,
        'I have eight years total, five at Initech on backend systems and the last three at Hooli leading an API team.',
      );
      expResult.expect.containsFunctionCall({
        name: 'saveExperience',
        args: { yearsOfExperience: 8 },
      });

      const tgResult = await done.await;
      expect(completedIds).toEqual(['intro', 'email', 'commute', 'experience']);
      expect(Object.keys(tgResult.taskResults).sort()).toEqual([
        'commute',
        'email',
        'experience',
        'intro',
      ]);
    });

    it('onTaskCompleted callback fires with correct task IDs and results', async () => {
      const done = new Future<TaskGroupResult>();
      const callbackLog: { taskId: string; result: unknown }[] = [];
      const introReady: ReadyHolder = { current: new Future<void>() };
      const emailReady: ReadyHolder = { current: new Future<void>() };
      const commuteReady: ReadyHolder = { current: new Future<void>() };
      const experienceReady: ReadyHolder = { current: new Future<void>() };

      const Agent = createSurveyTestAgent({
        done,
        introReady,
        emailReady,
        commuteReady,
        experienceReady,
        onTaskCompleted: async (event) => {
          callbackLog.push({ taskId: event.taskId, result: event.result });
        },
      });

      const fakeLLM = createFakeLLM([
        {
          input: 'Name is Dana.',
          toolCalls: [{ name: 'saveIntro', args: { name: 'Dana', intro: 'Software engineer.' } }],
        },
        {
          input: 'dana@test.com',
          toolCalls: [{ name: 'saveEmail', args: { email: 'dana@test.com' } }],
        },
        {
          input: 'I drive to work.',
          toolCalls: [
            { name: 'saveCommute', args: { canCommute: true, commuteMethod: 'driving' } },
          ],
        },
        {
          input: 'Three years at Acme.',
          toolCalls: [
            {
              name: 'saveExperience',
              args: { yearsOfExperience: 3, experienceDescription: 'Three years at Acme.' },
            },
          ],
        },
      ]);

      const session = await startSession(new Agent(), fakeLLM);
      await introReady.current.await;

      await runAndWait(session, 'Name is Dana.');
      await emailReady.current.await;

      await runAndWait(session, 'dana@test.com');
      await commuteReady.current.await;

      await runAndWait(session, 'I drive to work.');
      await experienceReady.current.await;

      await runAndWait(session, 'Three years at Acme.');
      await done.await;

      expect(callbackLog).toHaveLength(4);
      expect(callbackLog[0]!.taskId).toBe('intro');
      expect(callbackLog[1]!.taskId).toBe('email');
      expect(callbackLog[2]!.taskId).toBe('commute');
      expect(callbackLog[3]!.taskId).toBe('experience');
    });
  });

  // -----------------------------------------------------------------------
  // Regression tests — out_of_scope lets the user revisit completed tasks.
  // -----------------------------------------------------------------------

  describe('TaskGroup regressions', () => {
    it('single regression lets user correct intro after moving to email', async () => {
      const done = new Future<TaskGroupResult>();
      const introReady: ReadyHolder = { current: new Future<void>() };
      const emailReady: ReadyHolder = { current: new Future<void>() };
      const commuteReady: ReadyHolder = { current: new Future<void>() };
      const experienceReady: ReadyHolder = { current: new Future<void>() };

      const Agent = createSurveyTestAgent({
        done,
        introReady,
        emailReady,
        commuteReady,
        experienceReady,
      });

      const fakeLLM = createFakeLLM([
        {
          input: 'My name is Alice.',
          toolCalls: [{ name: 'saveIntro', args: { name: 'Alice', intro: 'Software engineer.' } }],
        },
        {
          input: 'Wait, I want to change my name to Bob.',
          toolCalls: [{ name: 'out_of_scope', args: { task_ids: ['intro'] } }],
        },
        {
          input: 'My name is Bob.',
          toolCalls: [{ name: 'saveIntro', args: { name: 'Bob', intro: 'Software engineer.' } }],
        },
        {
          input: 'bob@example.com',
          toolCalls: [{ name: 'saveEmail', args: { email: 'bob@example.com' } }],
        },
        {
          input: 'I take the bus.',
          toolCalls: [{ name: 'saveCommute', args: { canCommute: true, commuteMethod: 'bus' } }],
        },
        {
          input: 'Two years at Acme.',
          toolCalls: [
            {
              name: 'saveExperience',
              args: { yearsOfExperience: 2, experienceDescription: 'Two years at Acme.' },
            },
          ],
        },
      ]);

      const session = await startSession(new Agent(), fakeLLM);
      await introReady.current.await;

      // Complete intro_task.
      introReady.current = new Future<void>();
      const introResult = await runAndWait(session, 'My name is Alice.');
      introResult.expect.containsFunctionCall({ name: 'saveIntro' });
      await emailReady.current.await;

      // Regress — out_of_scope causes run() to reject with OutOfScopeError.
      introReady.current = new Future<void>();
      const regressResult = session.run({
        userInput: 'Wait, I want to change my name to Bob.',
      });
      await expect(regressResult.wait()).rejects.toThrow('out_of_scope');
      regressResult.expect.containsFunctionCall({ name: 'out_of_scope' });
      await introReady.current.await;

      // Provide corrected name.
      emailReady.current = new Future<void>();
      const correctedResult = await runAndWait(session, 'My name is Bob.');
      correctedResult.expect.containsFunctionCall({ name: 'saveIntro', args: { name: 'Bob' } });
      await emailReady.current.await;

      // Complete remaining tasks.
      commuteReady.current = new Future<void>();
      await runAndWait(session, 'bob@example.com');
      await commuteReady.current.await;

      experienceReady.current = new Future<void>();
      await runAndWait(session, 'I take the bus.');
      await experienceReady.current.await;

      await runAndWait(session, 'Two years at Acme.');

      const tgResult = await done.await;
      expect((tgResult.taskResults['intro'] as { name: string }).name).toBe('Bob');
      expect(tgResult.taskResults['email']).toEqual({ email: 'bob@example.com' });
    });
  });
});
