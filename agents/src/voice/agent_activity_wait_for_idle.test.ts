// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { Future, delay } from '../utils.js';
import { Agent } from './agent.js';
import type { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';
import { FakeLLM } from './testing/fake_llm.js';

async function startSession(llm?: FakeLLM) {
  const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
  await session.start({ agent: new Agent({ instructions: 'test' }) });
  const activity = (session as unknown as { activity: AgentActivity }).activity;
  // every pass of the idle loop checks for an end of turn first
  const passes = vi.spyOn(activity as never, 'waitForEndOfTurn');
  return { session, activity, passes };
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

  it.each(['close', 'shutdown'] as const)(
    'rejects pending foreground work during %s',
    async (method) => {
      const { session } = await startSession();
      const callback = vi.fn();
      const event = AgentSessionEventTypes.UserStateChanged;
      const listeners = session.listenerCount(event);
      session._updateUserState('speaking');
      const pending = session.waitForIdleAndHold(callback).catch((error: unknown) => error);

      try {
        await vi.waitFor(() => expect(session.listenerCount(event)).toBe(listeners + 1));
        if (method === 'shutdown') session.shutdown({ drain: true });
        await session.close();

        expect(await pending).toMatchObject({ name: 'AbortError' });
        expect(callback).not.toHaveBeenCalled();
        expect(session.listenerCount(event)).toBe(listeners);
      } finally {
        await session.close();
      }
    },
  );

  it.each(['close', 'shutdown'] as const)(
    'rejects pending foreground work while onExit drains during %s',
    async (method) => {
      const enteredExit = new Future<void>();
      const releaseExit = new Future<void>();
      class BlockingExitAgent extends Agent {
        async onExit() {
          enteredExit.resolve();
          await releaseExit.await;
        }
      }
      const session = new AgentSession({ vad: null, turnHandling: { turnDetection: null } });
      await session.start({ agent: new BlockingExitAgent({ instructions: 'test' }) });
      const callback = vi.fn();
      const event = AgentSessionEventTypes.UserStateChanged;
      const listeners = session.listenerCount(event);
      session._updateUserState('speaking');
      const pending = session.waitForIdleAndHold(callback).catch((error: unknown) => error);
      let closing: Promise<void> | undefined;

      try {
        await vi.waitFor(() => expect(session.listenerCount(event)).toBe(listeners + 1));
        if (method === 'shutdown') session.shutdown({ drain: true });
        closing = session.close();
        await enteredExit.await;
        session._updateUserState('listening');

        const result = await pending;
        expect(callback).not.toHaveBeenCalled();
        expect(result).toMatchObject({ name: 'AbortError' });
        expect(session.listenerCount(event)).toBe(listeners);
      } finally {
        releaseExit.resolve();
        await (closing ?? session.close());
      }
    },
  );

  it('rejects pending foreground work when its activity is replaced', async () => {
    const { session } = await startSession();
    const callback = vi.fn();
    const event = AgentSessionEventTypes.UserStateChanged;
    const listeners = session.listenerCount(event);
    session._updateUserState('speaking');
    const pending = session.waitForIdleAndHold(callback).catch((error: unknown) => error);

    try {
      await vi.waitFor(() => expect(session.listenerCount(event)).toBe(listeners + 1));
      await session._updateActivity(new Agent({ instructions: 'next agent' }));

      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(callback).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('rejects an idle wait on an already closed activity', async () => {
    const { session, activity } = await startSession();
    await session.close();

    await expect(activity.waitForIdle()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
