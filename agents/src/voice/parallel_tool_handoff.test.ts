// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { handoff, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { delay } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';
import { FakeLLM } from './testing/fake_llm.js';

class Greeter extends Agent {
  constructor() {
    super({ instructions: 'greeter' });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply({ userInput: 'greet' });
  }
}

class Router extends Agent {
  constructor(saveDelay: number) {
    super({
      instructions: 'router',
      tools: [
        tool({
          name: 'handoff',
          description: 'Hand off to the greeter.',
          parameters: z.object({}),
          execute: async () => handoff({ agent: new Greeter() }),
        }),
        tool({
          name: 'save_note',
          description: 'Save a note.',
          parameters: z.object({}),
          execute: async () => {
            await delay(saveDelay);
            return 'saved';
          },
        }),
      ],
    });
  }
}

describe('parallel tool handoff', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it.each([
    ['sibling immediate', 0],
    ['sibling delayed', 500],
  ])('keeps the handoff when the %s tool finishes afterward', async (_name, saveDelay) => {
    const llm = new FakeLLM([
      {
        input: 'go',
        toolCalls: [
          { name: 'handoff', args: {} },
          { name: 'save_note', args: {} },
        ],
      },
      { input: 'greet', content: 'hello from the greeter' },
    ]);
    const session = new AgentSession({ llm });
    const messages: string[] = [];
    session.on(
      AgentSessionEventTypes.ConversationItemAdded,
      (event: ConversationItemAddedEvent) => {
        if (event.item.type === 'message' && event.item.role === 'assistant') {
          messages.push(event.item.textContent ?? '');
        }
      },
    );

    try {
      await session.start({ agent: new Router(saveDelay) });
      await session.run({ userInput: 'go' }).wait();

      expect(session.currentAgent).toBeInstanceOf(Greeter);
      await vi.waitFor(() => expect(messages).toContain('hello from the greeter'), {
        timeout: 3000,
      });
    } finally {
      await session.close();
    }
  });
});
