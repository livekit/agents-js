// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test: a user who goes `away` must not block the activity's idle wait.
 *
 * `AgentActivity.waitForInactive` treated every user state other than `listening` as active,
 * so the `away` state (set by `userAwayTimeout`) held the loop open. `ToolExecutor.deliverReply`
 * awaits `waitForIdle()` before it generates the follow-up reply, so the deferred result of a
 * non-blocking tool was never spoken to a user who went quiet while waiting for it.
 */
import { describe, expect, it, vi } from 'vitest';
import { tool } from '../llm/tool_context.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type SpeechCreatedEvent } from './events.js';
import { FakeLLM } from './testing/fake_llm.js';

describe('AgentActivity idle while the user is away', () => {
  it('generates the deferred reply of a non-blocking tool after the user goes away', async () => {
    const llm = new FakeLLM([
      { input: 'check my fines', toolCalls: [{ name: 'slow_lookup', args: {} }] },
      { input: '"looking it up"', content: 'Let me check.' },
    ]);
    const toolStarted = new Future<void>();
    const releaseResult = new Future<void>();
    const agent = new Agent({
      instructions: 'test',
      tools: {
        slow_lookup: tool({
          description: 'Look something up slowly',
          execute: async (_, { ctx }) => {
            await ctx.update('looking it up');
            toolStarted.resolve();
            await releaseResult.await;
            return 'two fines';
          },
        }),
      },
    });

    const session = new AgentSession({ llm, vad: null, userAwayTimeout: 0.05 });
    session.output.setAudioEnabled(false);
    session.output.setTranscriptionEnabled(false);
    const speeches: SpeechCreatedEvent[] = [];
    session.on(AgentSessionEventTypes.SpeechCreated, (ev) => speeches.push(ev));

    await session.start({ agent });
    try {
      const speech = session.generateReply({ userInput: 'check my fines' });
      await toolStarted.await;
      await speech.waitForPlayout();

      // The user stays quiet: the away timer moves the session out of `listening`.
      await vi.waitFor(() => expect(session.userState).toBe('away'));

      const speechesBefore = speeches.length;
      releaseResult.resolve();

      // The deferred result must still reach the user.
      await vi.waitFor(() => expect(speeches.length).toBeGreaterThan(speechesBefore));
      expect(speeches[speeches.length - 1]!.source).toBe('generate_reply');
      expect(session.userState).toBe('away');
    } finally {
      releaseResult.resolve();
      await session.close();
    }
  });
});
