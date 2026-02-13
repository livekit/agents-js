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
 * 1. Agent -> onEnter -> AgentTask -> onEnter -> self.complete
 *    COVERED: "agent calls a task in onEnter" (WelcomeTask)
 *
 * 2. Agent -> onEnter -> AgentTask -> onEnter -> generateReply -> User -> Tool -> self.complete
 *    NOT TESTABLE: session.run() rejects with "speech scheduling draining" when task is started
 *    from onEnter. Works in production (basic_agent_task.ts) with real voice/STT.
 *    Tool-triggered variant COVERED: "LLM-powered IntroTask", "LLM-powered GetEmailTask"
 *
 * 3. Agent -> Tool Call -> AgentTask -> User message -> Tool Call -> self.complete
 *    COVERED: "LLM-powered IntroTask", "LLM-powered GetEmailTask"
 *
 * 4. Agent -> Tool handoff -> onExit -> AgentTask -> self.complete -> handoff target
 *    DEADLOCK: AgentTask.run() from onExit during updateAgent transition holds activity lock.
 *    onExit + AgentTask COVERED via harness: "agent calls a task in onExit" (createSpeechTask).
 */

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

    // Ref: python livekit-agents/livekit/agents/voice/agent.py - 739-841 lines.
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
        try {
          const result = await new WelcomeTask().run();
          done.resolve(result);
        } catch (error) {
          done.reject(asError(error));
        }
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
        try {
          const order: string[] = [];
          const first = await new FirstTask().run();
          order.push('first');
          const second = await new SecondTask().run();
          order.push('second');
          done.resolve({ first, second, order });
        } catch (error) {
          done.reject(asError(error));
        }
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
          try {
            const result = await new IntroTask().run();
            done.resolve(result);
          } catch (error) {
            done.reject(asError(error));
          }
        }
      }

      const llmModel = new openai.LLM({ model: 'gpt-4o-mini', temperature: 0 });
      const session = await startSession(new ParentAgent(), { llm: llmModel });

      const result = session.run({
        userInput: "I'm Sam and I'm a frontend engineer.",
      });
      await result.wait();

      const taskResult = await done.await;
      expect(taskResult.name.toLowerCase()).toContain('sam');
      expect(taskResult.role.toLowerCase()).toMatch(/frontend/);
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

      const llmModel = new openai.LLM({ model: 'gpt-4o-mini', temperature: 0 });
      const session = await startSession(new ToolAgent(), { llm: llmModel });
      const result = session.run({ userInput: 'Please capture my email using your tool.' });
      await result.wait();

      result.expect.containsFunctionCall({ name: 'captureEmail' });

      expect(toolCallCount).toBe(1);
      expect(taskOnEnterCount).toBe(1);
      // Critical parity check: resume path must not run parent onEnter again.
      expect(parentOnEnterCount).toBe(1);
    },
  );

  itIfOpenAI('LLM-powered IntroTask (python survey parity) records intro details', async () => {
    let introTaskResult: { name: string; intro: string } | undefined;
    let runIntroTaskCalls = 0;
    let recordIntroToolCalls = 0;

    // Ref: python examples/survey/survey_agent.py - 248-274 lines.
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

    const llmModel = new openai.LLM({ model: 'gpt-4o-mini', temperature: 0 });
    const session = await startSession(new ParentAgent(), { llm: llmModel });
    const triggerRun = session.run({ userInput: 'Please run the intro task.' });
    await triggerRun.wait();
    triggerRun.expect.containsFunctionCall({ name: 'collectIntroWithTask' });

    const answerRun = session.run({
      userInput: "I'm Morgan, and I'm a backend engineer focused on APIs.",
    });
    await answerRun.wait();

    expect(runIntroTaskCalls).toBe(1);
    expect(recordIntroToolCalls).toBeGreaterThanOrEqual(1);
    expect(introTaskResult).toBeDefined();
    expect(introTaskResult!.name.toLowerCase()).toContain('morgan');
    expect(introTaskResult!.intro.toLowerCase()).toMatch(/backend|api/);
  });

  itIfOpenAI(
    'LLM-powered GetEmailTask (python workflow parity) captures email in AgentTask',
    async () => {
      let capturedEmail = '';
      let runEmailTaskCalls = 0;
      let updateEmailToolCalls = 0;

      // Ref: python livekit-agents/livekit/agents/beta/workflows/email_address.py - 27-131 lines.
      class GetEmailTask extends voice.AgentTask<string> {
        constructor() {
          super({
            instructions:
              'You are responsible only for capturing an email address. ' +
              'Extract the email from the latest user message and call updateEmailAddress exactly once.',
            tools: {
              updateEmailAddress: llm.tool({
                description: 'Store the user email address and complete the task.',
                parameters: z.object({
                  email: z.string().describe('The user email address'),
                }),
                execute: async ({ email }) => {
                  updateEmailToolCalls += 1;
                  const normalized = email
                    .trim()
                    .toLowerCase()
                    .replace(/[.,!?;:]+$/g, '');
                  this.complete(normalized);
                  return `Email captured: ${normalized}`;
                },
              }),
            },
          });
        }

        async onEnter() {
          this.session.generateReply({
            instructions:
              'Ask for the email briefly if needed, then call updateEmailAddress after receiving it.',
          });
        }
      }

      class ParentAgent extends voice.Agent {
        constructor() {
          super({
            instructions:
              'When user asks to capture email via task, ALWAYS call collectEmailWithTask exactly once.',
            tools: {
              collectEmailWithTask: llm.tool({
                description: 'Run GetEmailTask and return the captured email.',
                parameters: z.object({}),
                execute: async () => {
                  runEmailTaskCalls += 1;
                  const result = await new GetEmailTask().run();
                  capturedEmail = result;
                  return result;
                },
              }),
            },
          });
        }
      }

      const llmModel = new openai.LLM({ model: 'gpt-4o-mini', temperature: 0 });
      const session = await startSession(new ParentAgent(), { llm: llmModel });
      const triggerRun = session.run({ userInput: 'Please capture my email with the task.' });
      await triggerRun.wait();
      triggerRun.expect.containsFunctionCall({ name: 'collectEmailWithTask' });

      const answerRun = session.run({ userInput: 'My email is jordan.smith@example.com.' });
      await answerRun.wait();

      expect(runEmailTaskCalls).toBe(1);
      expect(updateEmailToolCalls).toBeGreaterThanOrEqual(1);
      expect(capturedEmail).toBe('jordan.smith@example.com');
    },
  );

  // Scenario: Agent -> Tool handoff -> onExit -> AgentTask -> self.complete -> handoff target
  // Known to deadlock: AgentTask.run() from onExit during updateAgent/handoff transition holds
  // the activity lock. Use createSpeechTask harness (see "agent calls a task in onExit") to run
  // AgentTask in onExit outside the handoff path instead.

  it('agent calls a task in onExit', async () => {
    const done = new Future<string>();
    let oldAgentOnEnterCount = 0;

    class ExitTask extends voice.AgentTask<string> {
      constructor() {
        super({ instructions: 'Return on-exit marker.' });
      }

      async onEnter() {
        this.complete('exit-task-finished');
      }
    }

    class OldAgent extends voice.Agent {
      constructor() {
        super({ instructions: 'Old agent that runs an AgentTask in onExit.' });
      }

      async onEnter() {
        oldAgentOnEnterCount += 1;
      }

      async onExit() {
        if (done.done) {
          return;
        }
        try {
          const result = await new ExitTask().run();
          done.resolve(result);
        } catch (error) {
          done.reject(asError(error));
        }
      }
    }

    const oldAgent = new OldAgent();
    const session = await startSession(oldAgent);
    const currentActivity = (session as any).activity as {
      createSpeechTask: (options: {
        taskFn: () => Promise<void>;
        inlineTask?: boolean;
        name?: string;
      }) => { result: Promise<void> };
    };
    // Non-parity note: Python/JS both hold the session activity lock while draining on updateAgent,
    // so invoking AgentTask.run() from onExit during that lock path can deadlock.
    // This harness triggers onExit via an inline speech task outside updateAgent's lock scope
    // to validate AgentTask behavior in onExit itself (the scenario requested by this test).
    await currentActivity.createSpeechTask({
      taskFn: async () => oldAgent.onExit(),
      inlineTask: true,
      name: 'AgentActivity_onExit_testHarness',
    }).result;

    await expect(done.await).resolves.toBe('exit-task-finished');
    expect(oldAgentOnEnterCount).toBe(1);
    expect((session as any).agent).toBe(oldAgent);
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
        try {
          const task = new SingleUseTask();
          const first = await task.run();
          let secondRunError = '';

          try {
            await task.run();
          } catch (error) {
            secondRunError = error instanceof Error ? error.message : String(error);
          }

          done.resolve({ first, secondRunError });
        } catch (error) {
          done.reject(asError(error));
        }
      }
    }

    await startSession(new ParentAgent());
    const result = await done.await;
    expect(result.first).toBe('ok');
    expect(result.secondRunError).toContain('cannot be awaited multiple times');
  });
});
