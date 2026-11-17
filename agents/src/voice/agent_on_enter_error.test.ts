// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handoff, tool } from '../llm/tool_context.js';
import { initializeLogger, log } from '../log.js';
import { Future } from '../utils.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

/** The error-level records that carry `error`. */
function errorRecordsOf(errorLog: { mock: { calls: unknown[][] } }, error: unknown) {
  return errorLog.mock.calls.filter(
    (args) => (args[0] as { error?: unknown } | undefined)?.error === error,
  );
}

describe('an exception thrown from onEnter', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['start', 'updateAgent', 'tool handoff'] as const)(
    'is logged once when the agent is activated by %s',
    async (path) => {
      const failure = new Error('onEnter failed');
      const entered = new Future<void>();
      const failing = Agent.create({
        instructions: 'failing agent',
        onEnter: async () => {
          entered.resolve();
          throw failure;
        },
      });
      const root = Agent.create({
        instructions: 'root',
        tools: [
          tool({
            name: 'transfer',
            description: 'Transfer to the next agent.',
            execute: async () => handoff({ agent: failing, returns: 'transferred' }),
          }),
        ],
      });
      const session = new AgentSession({
        llm: new FakeLLM([
          { input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] },
          { input: 'hi', content: 'hello' },
        ]),
        turnHandling: { turnDetection: 'manual' },
      });
      const errorLog = vi.spyOn(log(), 'error');

      try {
        if (path === 'start') {
          await session.start({ agent: failing });
        } else {
          await session.start({ agent: root });
          if (path === 'updateAgent') {
            session.updateAgent(failing);
          } else {
            session.generateReply({ userInput: 'transfer' });
          }
        }
        await entered.await;

        await vi.waitFor(() => expect(errorRecordsOf(errorLog, failure)).toHaveLength(1));
        expect(errorRecordsOf(errorLog, failure)[0]![1]).toBe('error in onEnter');
        // the session keeps going, as before
        await session.run({ userInput: 'hi' }).wait();
        expect(errorRecordsOf(errorLog, failure)).toHaveLength(1);
      } finally {
        await session.close();
      }
    },
  );

  it('is logged once for an AgentTask awaited while a run is active', async () => {
    // before, the awaiting AgentTask logged it too ("error in onEnter task of agent ...")
    const failure = new Error('onEnter failed after completing');
    const result = new Future<unknown>();
    const task = AgentTask.create<string>({
      instructions: 'finish the task',
      onEnter: async () => {
        task.complete('done');
        throw failure;
      },
    });
    const root = Agent.create({
      instructions: 'root',
      tools: [
        tool({
          name: 'transfer',
          description: 'Run the task.',
          execute: async () => {
            const value = await task.run();
            result.resolve(value);
            return value;
          },
        }),
      ],
    });
    const session = new AgentSession({
      llm: new FakeLLM([{ input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] }]),
      turnHandling: { turnDetection: 'manual' },
    });
    const errorLog = vi.spyOn(log(), 'error');

    try {
      await session.start({ agent: root });
      const run = session.run({ userInput: 'transfer' });
      expect(await result.await).toBe('done');
      await run.wait();

      expect(errorRecordsOf(errorLog, failure)).toHaveLength(1);
      expect(errorRecordsOf(errorLog, failure)[0]![1]).toBe('error in onEnter');
    } finally {
      await session.close();
    }
  });

  it('is not logged when it is a cancellation', async () => {
    const abort = new DOMException('cancelled', 'AbortError');
    const entered = new Future<void>();
    const agent = Agent.create({
      instructions: 'agent',
      onEnter: async () => {
        entered.resolve();
        throw abort;
      },
    });
    const session = new AgentSession({ llm: new FakeLLM([]) });
    const errorLog = vi.spyOn(log(), 'error');

    try {
      await session.start({ agent });
      await entered.await;
      // let the onEnter task settle
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(errorRecordsOf(errorLog, abort)).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});
