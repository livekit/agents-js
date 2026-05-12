// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the survey agent's TaskGroup workflow.
 *
 * Demonstrates the best practices documented in
 * https://docs.livekit.io/agents/logic/tasks/#testing-task-groups:
 *
 * - Initialize userData: tasks read session.userData.candidateName and write
 *   into taskResults.
 * - Sleep before the first session.run() and between TaskGroup sub-tasks so the
 *   new sub-task can take over.
 * - Drive multiple turns and use containsFunctionCall() instead of coupling to
 *   a specific event index.
 * - Parse item.args with JSON.parse before asserting.
 * - Don't assert on startup output produced in onEnter().
 * - Test tasks in isolation and as a group.
 *
 * Test-only adjustment: test task subclasses no-op onEnter() prompts because
 * FakeLLM is user-input driven. The behavioral test also suppresses the
 * follow-up prompt emitted after partial records. SurveyAgentForTesting disables
 * the final CSV write and skips the email step so the test stays offline-safe
 * and side-effect free.
 */
import { Future, asError, beta, initializeLogger, voice } from '@livekit/agents';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BehavioralResults,
  BehavioralTask,
  CommuteTask,
  ExperienceTask,
  IntroTask,
  type SurveyUserData,
} from '../survey_agent.js';

const { TaskGroup } = beta;
type TaskGroupResult = beta.TaskGroupResult;
type TaskCompletedEvent = beta.TaskCompletedEvent;

initializeLogger({ pretty: true, level: 'warn' });

const TASK_TRANSITION_DELAY = 500;

function createUserData(): SurveyUserData {
  return { filename: 'survey-results-test.csv', candidateName: '', taskResults: {} };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function calledTools(session: voice.AgentSession<SurveyUserData>): Set<string> {
  return new Set(
    session.history.items.filter((item) => item.type === 'function_call').map((item) => item.name),
  );
}

function lastCalls(session: voice.AgentSession<SurveyUserData>, names: Set<string>) {
  const found = new Map<string, { args: string }>();
  for (const item of [...session.history.items].reverse()) {
    if (item.type === 'function_call' && names.has(item.name) && !found.has(item.name)) {
      found.set(item.name, item);
    }
    if (found.size === names.size) break;
  }
  return found;
}

async function driveUntilCalled(
  session: voice.AgentSession<SurveyUserData>,
  options: {
    expected: string | Set<string>;
    initial: string;
    nudge?: string;
    maxTurns?: number;
  },
) {
  const required =
    typeof options.expected === 'string' ? new Set([options.expected]) : options.expected;
  await runAndWait(session, options.initial);

  for (let turn = 1; turn < (options.maxTurns ?? 4); turn++) {
    const called = calledTools(session);
    if ([...required].every((name) => called.has(name))) break;
    await runAndWait(session, options.nudge ?? "Yes, that's right. Please go ahead and record it.");
  }

  const called = calledTools(session);
  expect([...required].every((name) => called.has(name))).toBe(true);
  return lastCalls(session, required);
}

class SingleTaskAgent<ResultT> extends voice.Agent<SurveyUserData> {
  constructor(private readonly task: voice.AgentTask<ResultT, SurveyUserData>) {
    super({ instructions: 'Run a single survey task.' });
  }

  async onEnter() {
    await this.task.run();
  }
}

class TestIntroTask extends IntroTask {
  async onEnter() {}
}

class TestCommuteTask extends CommuteTask {
  async onEnter() {}
}

class TestExperienceTask extends ExperienceTask {
  async onEnter() {}
}

class TestBehavioralTask extends BehavioralTask {
  constructor() {
    super();
    Object.defineProperty(this, 'checkCompletion', {
      value: () => {
        const partial = (this as unknown as { partial: Partial<BehavioralResults> }).partial;
        if (partial.strengths && partial.weaknesses && partial.workStyle) {
          this.complete({
            strengths: partial.strengths,
            weaknesses: partial.weaknesses,
            workStyle: partial.workStyle,
          });
        }
      },
    });
  }

  async onEnter() {}
}

class SurveyAgentForTesting extends voice.Agent<SurveyUserData> {
  constructor(
    private readonly completedIds: string[],
    private readonly done: Future<TaskGroupResult>,
  ) {
    super({ instructions: 'You are a survey agent screening candidates.' });
  }

  async onEnter() {
    await withFutureResolution(this.done, async () => {
      const group = new TaskGroup({
        summarizeChatCtx: false,
        onTaskCompleted: async (event: TaskCompletedEvent) => {
          this.completedIds.push(event.taskId);
        },
      });

      group.add(() => new TestIntroTask(), { id: 'intro', description: 'Collect name and intro.' });
      group.add(() => new TestCommuteTask(), { id: 'commute', description: 'Ask about commute.' });
      group.add(() => new TestExperienceTask(), {
        id: 'experience',
        description: 'Collect work history.',
      });

      const result = await group.run();
      this.session.userData.taskResults = result.taskResults;
      return result;
    });
  }
}

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
    await delay(TASK_TRANSITION_DELAY);
    return session;
  }

  it('IntroTask records the candidate name', async () => {
    const fakeLLM = createFakeLLM([
      {
        input:
          "Hi, my name is Alice. I'm a backend engineer with five years of experience building APIs at Acme.",
        toolCalls: [{ name: 'saveIntro', args: { name: 'Alice', intro: 'Backend engineer.' } }],
      },
    ]);
    const session = await startSession(new SingleTaskAgent(new TestIntroTask()), fakeLLM);

    await driveUntilCalled(session, {
      expected: 'saveIntro',
      initial:
        "Hi, my name is Alice. I'm a backend engineer with five years of experience building APIs at Acme.",
    });

    expect(session.userData.candidateName.toLowerCase()).toBe('alice');
  });

  it('CommuteTask records commute flexibility', async () => {
    const fakeLLM = createFakeLLM([
      {
        input: 'Yes, I can commute three days a week. I usually take the subway.',
        toolCalls: [{ name: 'saveCommute', args: { canCommute: true, commuteMethod: 'subway' } }],
      },
    ]);
    const session = await startSession(new SingleTaskAgent(new TestCommuteTask()), fakeLLM);

    const calls = await driveUntilCalled(session, {
      expected: 'saveCommute',
      initial: 'Yes, I can commute three days a week. I usually take the subway.',
    });

    const args = JSON.parse(calls.get('saveCommute')!.args);
    expect(args.canCommute).toBe(true);
    expect(args.commuteMethod).toBe('subway');
  });

  it('ExperienceTask records years and description', async () => {
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
    const session = await startSession(new SingleTaskAgent(new TestExperienceTask()), fakeLLM);

    const calls = await driveUntilCalled(session, { expected: 'saveExperience', initial: input });

    const args = JSON.parse(calls.get('saveExperience')!.args);
    expect(args.yearsOfExperience).toBe(5);
    expect(args.experienceDescription.toLowerCase()).toContain('acme');
  });

  it('BehavioralTask completes after all three records', async () => {
    const input =
      'My biggest strength is debugging hard distributed systems issues. My main weakness is that I sometimes over-engineer early prototypes. I work best as part of a team.';
    const fakeLLM = createFakeLLM([
      {
        input,
        toolCalls: [
          { name: 'saveStrengths', args: { strengths: 'Debugging distributed systems.' } },
          { name: 'saveWeaknesses', args: { weaknesses: 'Sometimes over-engineers prototypes.' } },
          { name: 'saveWorkStyle', args: { workStyle: 'team_player' } },
        ],
      },
    ]);
    const session = await startSession(new SingleTaskAgent(new TestBehavioralTask()), fakeLLM);

    await driveUntilCalled(session, {
      expected: new Set(['saveStrengths', 'saveWeaknesses', 'saveWorkStyle']),
      initial: input,
      maxTurns: 6,
    });
  });

  it('full TaskGroup flow records ordered task results', async () => {
    const completedIds: string[] = [];
    const done = new Future<TaskGroupResult>();
    const fakeLLM = createFakeLLM([
      {
        input:
          "My name is Bob, I'm a software engineer with eight years of experience focused on APIs.",
        toolCalls: [{ name: 'saveIntro', args: { name: 'Bob', intro: 'API-focused engineer.' } }],
      },
      {
        input: "Yes, I can commute three days a week. I'd be driving in.",
        toolCalls: [{ name: 'saveCommute', args: { canCommute: true, commuteMethod: 'driving' } }],
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
    const session = await startSession(new SurveyAgentForTesting(completedIds, done), fakeLLM);

    await driveUntilCalled(session, {
      expected: 'saveIntro',
      initial:
        "My name is Bob, I'm a software engineer with eight years of experience focused on APIs.",
    });
    await delay(TASK_TRANSITION_DELAY);

    await driveUntilCalled(session, {
      expected: 'saveCommute',
      initial: "Yes, I can commute three days a week. I'd be driving in.",
    });
    await delay(TASK_TRANSITION_DELAY);

    await driveUntilCalled(session, {
      expected: 'saveExperience',
      initial:
        'I have eight years total, five at Initech on backend systems and the last three at Hooli leading an API team.',
    });

    const result = await done.await;
    const results = session.userData.taskResults;

    expect(completedIds).toEqual(['intro', 'commute', 'experience']);
    expect(Object.keys(result.taskResults).sort()).toEqual(['commute', 'experience', 'intro']);
    expect((results.intro as { name: string }).name.toLowerCase()).toBe('bob');
    expect((results.commute as { canCommute: boolean; commuteMethod: string }).canCommute).toBe(
      true,
    );
    expect((results.commute as { canCommute: boolean; commuteMethod: string }).commuteMethod).toBe(
      'driving',
    );
    expect((results.experience as { yearsOfExperience: number }).yearsOfExperience).toBe(8);
  });
});
