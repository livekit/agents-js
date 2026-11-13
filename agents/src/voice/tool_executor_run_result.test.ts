// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '../llm/tool_context.js';
import { delay } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';
import { UPDATE_TEMPLATE } from './tool_executor.js';

describe('session.run() with an async tool', () => {
  it('settles after the deferred reply to the tool result', async () => {
    const llm = new FakeLLM([
      { input: 'go', toolCalls: [{ name: 'lookup', args: {} }] },
      {
        // tool outputs reach the model JSON-encoded
        input: JSON.stringify(
          UPDATE_TEMPLATE.replace('{functionName}', 'lookup').replace('{message}', 'started'),
        ),
        content: 'Working on it.',
        // keep the progress reply streaming while the tool result arrives
        duration: 150,
      },
      { input: 'instructions: deliver the result', content: 'Here is the result.' },
    ]);
    const agent = new Agent({
      instructions: 'test',
      tools: {
        lookup: tool({
          description: 'Look something up',
          parameters: z.object({}),
          execute: async (_, { ctx }) => {
            await ctx.update('started');
            await delay(25);
            return 'final result';
          },
        }),
      },
    });
    const session = new AgentSession({
      llm,
      vad: null,
      turnHandling: { turnDetection: null },
      toolHandling: {
        asyncOptions: {
          replyAtTailTemplate: 'instructions: deliver the result',
          replyMaybeCoveredTemplate: 'instructions: deliver the result',
        },
      },
    });

    try {
      await session.start({ agent });
      const run = session.run({ userInput: 'go' });
      const settled = await Promise.race([
        run.wait().then(() => 'settled'),
        delay(1000).then(() => 'pending'),
      ]);
      expect(settled).toBe('settled');

      const messages = session.history.items
        .filter((item) => item.type === 'message' && item.role === 'assistant')
        .map((item) => (item.type === 'message' ? item.textContent : undefined));
      expect(messages).toContain('Here is the result.');
    } finally {
      await session.close();
    }
  });
});
