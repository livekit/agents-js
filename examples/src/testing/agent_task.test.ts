// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Future, initializeLogger, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

initializeLogger({ pretty: true, level: 'warn' });

/**
 * AgentTask scenario coverage:
 *
 * 1. Agent -\> onEnter -\> AgentTask -\> onEnter -\> self.complete
 *    COVERED: "agent calls a task in onEnter" (WelcomeTask)
 *
 * 2. Agent -\> onEnter -\> AgentTask -\> onEnter -\> generateReply -\> User -\> Tool -\> self.complete
 *    NOT TESTABLE: session.run() rejects with "speech scheduling draining" when task is started
 *    from onEnter. Works in production (basic_agent_task.ts) with real voice/STT.
 *    Tool-triggered variant COVERED: "LLM-powered IntroTask", "LLM-powered GetEmailTask"
 *
 * 3. Agent -\> Tool Call -\> AgentTask -\> User message -\> Tool Call -\> self.complete
 *    COVERED: "LLM-powered IntroTask", "LLM-powered GetEmailTask"
 *
 * 4. Agent -\> Tool handoff -\> onExit -\> AgentTask -\> self.complete -\> handoff target
 *    DEADLOCK: AgentTask.run() from onExit during updateAgent transition holds activity lock.
 *    NOT COVERED in this suite due to known deadlock limitation.
 */

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

function createOpenAILLM(): openai.LLM {
  return new openai.LLM({ model: 'gpt-4o-mini', temperature: 0 });
}

async function runAndWait(session: voice.AgentSession, userInput: string) {
  const result = session.run({ userInput });
  await result.wait();
  return result;
}

describe('AgentTask examples', { timeout: 120_000 }, () => {
  const sessions: voice.AgentSession[] = [];

  afterEach(async () => {
    await Promise.allSettled(sessions.map((s) => s.close()));
    sessions.length = 0;
  });

  async function startSession(agent: voice.Agent, options?: { llm?: openai.LLM }) {
    const session = new voice.AgentSession({ llm: options?.llm });
    sessions.push(session);
    await session.start({ agent });
    return session;
  }

  it('agent calls a task in onEnter', async () => {
    const done = new Future<string>();

    class WelcomeTask extends voice.AgentTask<string> {
      constructor() {
        super({ instructions: 'Collect a welcome token and finish quickly.' });
      }

      async onEnter() {
        this.complete('welcome-token');
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'Parent agent used for AgentTask lifecycle tests.' });
      }

      async onEnter() {
        await withFutureResolution(done, async () => new WelcomeTask().run());
      }
    }

    await startSession(new ParentAgent());
    await expect(done.await).resolves.toBe('welcome-token');
  });

  it('agent calls two tasks in onEnter', async () => {
    const done = new Future<{ first: number; second: number; order: string[] }>();

    class FirstTask extends voice.AgentTask<number> {
      constructor() {
        super({ instructions: 'Return first value.' });
      }

      async onEnter() {
        this.complete(1);
      }
    }

    class SecondTask extends voice.AgentTask<number> {
      constructor() {
        super({ instructions: 'Return second value.' });
      }

      async onEnter() {
        this.complete(2);
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'Parent agent for sequential task orchestration.' });
      }

      async onEnter() {
        await withFutureResolution(done, async () => {
          const order: string[] = [];
          const first = await new FirstTask().run();
          order.push('first');
          const second = await new SecondTask().run();
          order.push('second');
          return { first, second, order };
        });
      }
    }

    await startSession(new ParentAgent());
    await expect(done.await).resolves.toEqual({
      first: 1,
      second: 2,
      order: ['first', 'second'],
    });
  });

  const itIfOpenAI = process.env.OPENAI_API_KEY ? it : it.skip;

  // Scenario 2: Agent onEnter -> AgentTask -> onEnter -> generateReply -> User -> Tool -> self.complete
  itIfOpenAI(
    'scenario 2: onEnter AgentTask with generateReply then user input via run()',
    async () => {
      const done = new Future<{ name: string; role: string }>();

      class IntroTask extends voice.AgentTask<{ name: string; role: string }> {
        constructor() {
          super({
            instructions:
              'You are collecting a name and role. Extract both from user input and call recordIntro.',
            tools: {
              recordIntro: llm.tool({
                description: 'Record the name and role',
                parameters: z.object({
                  name: z.string().describe('User name'),
                  role: z.string().describe('User role'),
                }),
                execute: async ({ name, role }) => {
                  this.complete({ name, role });
                  return 'recorded';
                },
              }),
            },
          });
        }

        async onEnter() {
          this.session.generateReply({
            instructions: 'Ask the user for their name and role.',
          });
        }
      }

      class ParentAgent extends voice.Agent {
        constructor() {
          super({ instructions: 'Parent agent that launches IntroTask on enter.' });
        }

        async onEnter() {
          await withFutureResolution(done, async () => new IntroTask().run());
        }
      }

      const llmModel = createOpenAILLM();
      const session = await startSession(new ParentAgent(), { llm: llmModel });

      let result = await runAndWait(session, "I'm Sam and I'm a frontend engineer.");

      const taskResult = await done.await;
      result.expect.containsFunctionCall({ name: 'recordIntro' });
      expect(taskResult.name.toLowerCase()).toContain('sam');
      expect(taskResult.role.toLowerCase()).toMatch(/frontend/);

      result = await runAndWait(session, 'What is my name and role?');
      result.expect
        .nextEvent()
        .isMessage({ role: 'assistant' })
        .judge(llmModel, { intent: 'should answer name as Sam and role as frontend engineer' });
    },
  );

  itIfOpenAI(
    'agent calls a task in a tool; resuming previous activity does not execute onEnter again',
    async () => {
      let parentOnEnterCount = 0;
      let taskOnEnterCount = 0;
      let toolCallCount = 0;

      class GetEmailAddressTask extends voice.AgentTask<string> {
        constructor() {
          super({ instructions: 'Capture an email address and complete.' });
        }

        async onEnter() {
          taskOnEnterCount += 1;
          this.complete('alice@example.com');
        }
      }

      class ToolAgent extends voice.Agent {
        constructor() {
          super({
            instructions:
              'When asked to capture email, ALWAYS call captureEmail exactly once, then respond briefly.',
            tools: {
              captureEmail: llm.tool({
                description: 'Capture an email by running a nested AgentTask.',
                parameters: z.object({}),
                execute: async () => {
                  toolCallCount += 1;
                  try {
                    const email = await new GetEmailAddressTask().run();
                    return `captured:${email}`;
                  } catch (error) {
                    throw error;
                  }
                },
              }),
            },
          });
        }

        async onEnter() {
          parentOnEnterCount += 1;
        }
      }

      const llmModel = createOpenAILLM();
      const session = await startSession(new ToolAgent(), { llm: llmModel });
      const result = await runAndWait(session, 'Please capture my email using your tool.');

      result.expect.containsFunctionCall({ name: 'captureEmail' });
      result.expect.containsAgentHandoff({ newAgentType: GetEmailAddressTask });
      result.expect.containsFunctionCallOutput({
        isError: false,
      });
      result.expect.containsMessage({ role: 'assistant' }).judge(llmModel, {
        intent: 'should answer email captured, not necessarily need to state the email address',
      });

      expect(toolCallCount).toBe(1);
      expect(taskOnEnterCount).toBe(1);
      expect(parentOnEnterCount).toBe(1);
    },
  );

  itIfOpenAI('IntroTask records intro details', async () => {
    let introTaskResult: { name: string; intro: string } | undefined;
    let runIntroTaskCalls = 0;
    let recordIntroToolCalls = 0;

    class IntroTask extends voice.AgentTask<{ name: string; intro: string }> {
      constructor() {
        super({
          instructions:
            'You are Alex, an interviewer. Extract the candidate name and a short intro from the latest user input. ' +
            'Use the tool recordIntro exactly once when both are available.',
          tools: {
            recordIntro: llm.tool({
              description: 'Record candidate name and intro summary.',
              parameters: z.object({
                name: z.string().describe('Candidate name'),
                introNotes: z.string().describe('A concise candidate intro summary'),
              }),
              execute: async ({ name, introNotes }) => {
                recordIntroToolCalls += 1;
                this.complete({ name, intro: introNotes });
                return 'Intro recorded.';
              },
            }),
          },
        });
      }

      async onEnter() {
        this.session.generateReply({
          instructions:
            'Ask the user for name and intro if missing, then call recordIntro with concise values.',
        });
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({
          instructions:
            'When the user asks to run the intro task, ALWAYS call collectIntroWithTask exactly once.',
          tools: {
            collectIntroWithTask: llm.tool({
              description: 'Launch the IntroTask and return the captured intro details.',
              parameters: z.object({}),
              execute: async () => {
                runIntroTaskCalls += 1;
                const result = await new IntroTask().run();
                introTaskResult = result;
                return JSON.stringify(result);
              },
            }),
          },
        });
      }
    }

    const llmModel = createOpenAILLM();
    const session = await startSession(new ParentAgent(), { llm: llmModel });
    const triggerRun = await runAndWait(session, 'Please run the intro task.');
    triggerRun.expect.containsFunctionCall({ name: 'collectIntroWithTask' });
    triggerRun.expect.containsMessage({ role: 'assistant' }).judge(llmModel, {
      intent: 'Ask the user for name and intro',
    });

    const answerRun = await runAndWait(
      session,
      "I'm Morgan, and I'm a backend engineer focused on APIs.",
    );
    answerRun.expect.containsAgentHandoff({ newAgentType: ParentAgent });

    expect(runIntroTaskCalls).toBe(1);
    expect(recordIntroToolCalls).toBeGreaterThanOrEqual(1);
    expect(introTaskResult).toBeDefined();
    expect(introTaskResult!.name.toLowerCase()).toContain('morgan');
    expect(introTaskResult!.intro.toLowerCase()).toMatch(/backend|api/);
  });

  it('AgentTask instance is non-reentrant (edge case)', async () => {
    const done = new Future<{ first: string; secondRunError: string }>();

    class SingleUseTask extends voice.AgentTask<string> {
      constructor() {
        super({ instructions: 'Single-use AgentTask edge case.' });
      }

      async onEnter() {
        this.complete('ok');
      }
    }

    class ParentAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'Agent validating AgentTask re-entrancy behavior.' });
      }

      async onEnter() {
        await withFutureResolution(done, async () => {
          const task = new SingleUseTask();
          const first = await task.run();
          let secondRunError = '';

          try {
            await task.run();
          } catch (error) {
            secondRunError = error instanceof Error ? error.message : String(error);
          }

          return { first, secondRunError };
        });
      }
    }

    await startSession(new ParentAgent());
    const result = await done.await;
    expect(result.first).toBe('ok');
    expect(result.secondRunError).toContain('cannot be awaited multiple times');
  });
});
