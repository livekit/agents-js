// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import { Agent, AgentTask } from './agent.js';
import { SchedulingPausedError } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return false;
}

async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  const result = await Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    sleep(ms).then(() => 'timeout' as const),
  ]);
  return result === 'settled';
}

describe('AgentSession.say() during an AgentTask pause', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('cancels the refused speech so the task hand-back and session close complete', async () => {
    class TransferTask extends AgentTask<void> {
      constructor() {
        super({ instructions: 'transfer task' });
      }
    }

    let holdController!: ReadableStreamDefaultController<string>;
    const holdStream = new ReadableStream<string>({
      start(controller) {
        holdController = controller;
      },
    });

    let task: TransferTask | undefined;
    class RootAgent extends Agent {
      constructor() {
        super({
          instructions: 'root',
          tools: [
            tool({
              name: 'transfer',
              description: 'Transfer the call.',
              parameters: z.object({}),
              execute: async () => {
                // A pending speech that is not drain-blocked keeps the pause waiting,
                // like a parallel tool reply in production.
                this.session.say(holdStream, { allowInterruptions: false });
                task = new TransferTask();
                await task.run();
                return 'transferred';
              },
            }),
          ],
        });
      }
    }

    const llm = new FakeLLM([{ input: 'go', toolCalls: [{ name: 'transfer', args: {} }] }]);
    const agent = new RootAgent();
    const session = new AgentSession({ llm });
    const internals = session as unknown as {
      activity?: { schedulingPaused: boolean };
      nextActivity?: { speechTasks: Set<{ done: boolean }> };
    };
    await session.start({ agent });

    session.generateReply({ userInput: 'go' });

    // the root activity is pausing and the task activity is queued as nextActivity
    expect(
      await waitFor(
        () => internals.activity?.schedulingPaused === true && internals.nextActivity !== undefined,
        5000,
      ),
    ).toBe(true);

    // say() during the pause is routed to the task activity, which has not started yet
    const taskActivity = internals.nextActivity!;
    let sayError: unknown;
    try {
      session.say('oops');
    } catch (error) {
      sayError = error;
    }
    expect(sayError).toBeInstanceOf(SchedulingPausedError);

    // the refused speech must not leave a parked speech task behind
    expect(await waitFor(() => [...taskActivity.speechTasks].every((t) => t.done), 1000)).toBe(
      true,
    );

    // let the hold speech finish so the pause completes and the task activity starts
    holdController.enqueue('please hold');
    holdController.close();
    expect(await waitFor(() => session.currentAgent === task, 5000)).toBe(true);

    // completing the task drains the task activity and resumes the root agent
    task!.complete(undefined);
    expect(
      await waitFor(
        () =>
          internals.activity === (agent._agentActivity as unknown) &&
          internals.activity?.schedulingPaused === false,
        3000,
      ),
    ).toBe(true);

    expect(await settlesWithin(session.close(), 3000)).toBe(true);
  }, 30_000);
});
