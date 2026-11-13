// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * A handoff batched with an ordinary tool must still switch agents.
 *
 * Tool outputs are collected in completion order. The loop that reads them used to assign the
 * agent task from every output, so an ordinary tool that finished last dropped the handoff
 * silently. Ports livekit/agents#7321.
 */
import { describe, expect, it, vi } from 'vitest';
import { handoff, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { delay } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

describe('parallel tool handoff', () => {
  it.each([0, 50])('switches agents when the sibling tool finishes %ims later', async (ms) => {
    const greeter = new Agent({ instructions: 'greeter' });
    const router = new Agent({
      instructions: 'router',
      tools: {
        transfer: tool({
          description: 'Hand off.',
          execute: async () => handoff({ agent: greeter }),
        }),
        save_note: tool({
          description: 'Save a note.',
          execute: async () => {
            await delay(ms);
            return 'saved';
          },
        }),
      },
    });
    const session = new AgentSession({
      llm: new FakeLLM([
        {
          input: 'go',
          toolCalls: [
            { name: 'transfer', args: {} },
            { name: 'save_note', args: {} },
          ],
        },
      ]),
      turnHandling: { turnDetection: 'manual' },
    });

    await session.start({ agent: router });
    try {
      await session.generateReply({ userInput: 'go' }).waitForPlayout();
      await vi.waitFor(() => expect(session.currentAgent).toBe(greeter));
    } finally {
      await session.close();
    }
  });
});
