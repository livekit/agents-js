// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for AgentTask handoffs triggered by a speech that predates
// the active run (livekit/agents#6313, ported from livekit/agents#6315).
//
// When AgentSession.start() runs onEnter and its reply calls a tool that
// awaits an AgentTask, nothing watches the tasks driving that handoff. The
// first session.run() then completes as soon as its own reply finishes —
// while the handoff is still mid-transition — and the run hangs or the next
// run races the transition. The fix watches the blocked handoff tasks on the
// active run for the duration of the activity transition.
//
// Without the fix, run('hi') below never resolves (the session stalls
// mid-handoff) and the test times out.
// Ref: python tests/test_nested_agent_task.py - test_handoff_from_pre_run_speech
import { describe, expect, it } from 'vitest';
import { tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

let taskOnEnterCompletedAt = 0;

class SimpleTask extends AgentTask<null> {
  constructor() {
    super({
      instructions: 'simple task',
      tools: [
        tool({
          name: 'finish',
          description: 'Called to complete the task.',
          execute: async () => {
            this.complete(null);
            return 'done';
          },
        }),
      ],
    });
  }

  async onEnter(): Promise<void> {
    // Widen the mid-transition window (old activity paused, new activity
    // still starting) so a run completing early is deterministically caught.
    await new Promise((r) => setTimeout(r, 500));
    this.session.generateReply({ userInput: 'task_greeting' });
    taskOnEnterCompletedAt = Date.now();
  }
}

class EnterHandoffAgent extends Agent {
  constructor() {
    super({
      instructions: 'root agent',
      tools: [
        tool({
          name: 'start_task',
          description: 'Transitions into SimpleTask.',
          execute: async () => {
            await new SimpleTask().run();
            return 'task completed';
          },
        }),
      ],
    });
  }

  async onEnter(): Promise<void> {
    // This speech predates any session.run(), so no run watches it.
    const handle = this.session.generateReply({ userInput: 'enter_greeting' });
    await handle.waitForPlayout();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ]);
}

describe('AgentTask handoff from pre-run speech', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('keeps the run alive until the handoff settles', async () => {
    const llm = new FakeLLM([
      // onEnter reply -> calls start_task; slow enough that run('hi') starts
      // before the tool call lands
      {
        input: 'enter_greeting',
        content: '',
        ttft: 1000,
        duration: 1000,
        toolCalls: [{ name: 'start_task', args: {} }],
      },
      // user says "hi" while the handoff is in flight; the only speech the
      // first run watches on its own
      { input: 'hi', content: 'hello!', ttft: 1000, duration: 2000 },
      // SimpleTask onEnter greeting
      { input: 'task_greeting', content: 'hello from task' },
      // user says "bye" -> LLM calls finish
      {
        input: 'bye',
        content: '',
        toolCalls: [{ name: 'finish', args: {} }],
      },
      // after start_task tool output, LLM responds
      { input: 'task completed', content: 'all done' },
    ]);

    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new EnterHandoffAgent() });

      await withTimeout(session.run({ userInput: 'hi' }).wait(), 10_000, "run('hi')");
      const runResolvedAt = Date.now();
      expect(session.currentAgent).toBeInstanceOf(SimpleTask);

      // the run must not complete mid-handoff: the new activity's onEnter
      // must already have finished when the run resolves
      expect(taskOnEnterCompletedAt).toBeGreaterThan(0);
      expect(runResolvedAt).toBeGreaterThanOrEqual(taskOnEnterCompletedAt);

      await withTimeout(session.run({ userInput: 'bye' }).wait(), 10_000, "run('bye')");
      expect(session.currentAgent).toBeInstanceOf(EnterHandoffAgent);
    } finally {
      await session.close().catch(() => {});
    }
  }, 30_000);
});
