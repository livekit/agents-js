// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { delay } from '../utils.js';
import { Agent } from './agent.js';
import type { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

async function startSession(llm?: FakeLLM) {
  const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
  await session.start({ agent: new Agent({ instructions: 'test' }) });
  const activity = (session as unknown as { activity: AgentActivity }).activity;
  // every pass of the idle loop checks for an end of turn first
  const passes = vi.spyOn(activity as never, 'waitForEndOfTurn');
  return { session, passes };
}

describe('AgentActivity.waitForIdle', () => {
  it('waits for the user to stop speaking without spinning', async () => {
    const { session, passes } = await startSession();
    try {
      session._updateUserState('speaking');
      const idle = session.waitForIdle();
      await delay(250);
      session._updateUserState('listening');
      await idle;

      expect(passes.mock.calls.length).toBeLessThan(10);
    } finally {
      await session.close();
    }
  });

  it('waits for the agent to finish speaking without spinning', async () => {
    const llm = new FakeLLM([{ input: 'hello', content: 'hi there', duration: 250 }]);
    const { session, passes } = await startSession(llm);
    try {
      session.generateReply({ userInput: 'hello' });
      await delay(20);
      passes.mockClear();
      const startedAt = Date.now();
      await session.waitForIdle();

      // the reply was still streaming, so the wait spanned it
      expect(Date.now() - startedAt).toBeGreaterThan(150);
      expect(passes.mock.calls.length).toBeLessThan(10);
    } finally {
      await session.close();
    }
  });
});
