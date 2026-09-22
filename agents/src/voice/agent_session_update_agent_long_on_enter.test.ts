// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

class AskNameTask extends AgentTask<null> {
  constructor() {
    super({
      instructions: 'ask name task',
      tools: [
        tool({
          name: 'record_name',
          description: 'Called when the user provides their name.',
          parameters: z.object({ name: z.string() }),
          execute: async () => {
            this.complete(null);
            return 'recorded';
          },
        }),
      ],
    });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply({ userInput: 'ask_name' });
  }
}

class SurveyAgent extends Agent {
  constructor() {
    super({ instructions: 'survey agent' });
  }

  async onEnter(): Promise<void> {
    await new AskNameTask().run();
  }
}

class Greeter extends Agent {
  constructor() {
    super({
      instructions: 'greeter agent',
      tools: [
        tool({
          name: 'start_survey',
          description: 'Called when the user is ready to start the survey.',
          execute: async () => {
            this.session.updateAgent(new SurveyAgent());
          },
        }),
      ],
    });
  }
}

class GreetingAgent extends Agent {
  constructor() {
    super({ instructions: 'greeting agent' });
  }

  async onEnter(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.session.generateReply({ userInput: 'delayed_greeting' });
  }
}

class GreeterToGreeting extends Agent {
  constructor() {
    super({
      instructions: 'greeter agent',
      tools: [
        tool({
          name: 'start',
          description: 'Called when the user asks to proceed.',
          execute: async () => {
            this.session.updateAgent(new GreetingAgent());
          },
        }),
      ],
    });
  }
}

function buildFakeLLM(): FakeLLM {
  return new FakeLLM([
    {
      input: 'ready',
      content: '',
      ttft: 100,
      duration: 100,
      toolCalls: [{ name: 'start_survey', args: {} }],
    },
    { input: 'ask_name', content: 'what is your name?', ttft: 100, duration: 100 },
    {
      input: 'Bob',
      content: '',
      ttft: 100,
      duration: 100,
      toolCalls: [{ name: 'record_name', args: { name: 'Bob' } }],
    },
  ]);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ]);
}

describe('AgentSession updateAgent with long onEnter', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('captures onEnter output after updateAgent', async () => {
    const llm = new FakeLLM([
      {
        input: 'go',
        content: '',
        ttft: 100,
        duration: 100,
        toolCalls: [{ name: 'start', args: {} }],
      },
      { input: 'delayed_greeting', content: 'hello!', ttft: 100, duration: 100 },
    ]);
    const session = new AgentSession({ llm });

    try {
      await session.start({ agent: new GreeterToGreeting() });

      const result = await withTimeout(session.run({ userInput: 'go' }).wait(), 5000, "run('go')");
      result.expect.containsMessage({ role: 'assistant' });
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('does not deadlock when updateAgent onEnter waits for a future turn', async () => {
    const session = new AgentSession({ llm: buildFakeLLM() });

    try {
      await session.start({ agent: new Greeter() });

      const firstResult = await withTimeout(
        session.run({ userInput: 'ready' }).wait(),
        5000,
        "run('ready')",
      );
      expect(firstResult).toBeDefined();
      firstResult.expect.containsMessage({ role: 'assistant' });

      const secondResult = await withTimeout(
        session.run({ userInput: 'Bob' }).wait(),
        5000,
        "run('Bob')",
      );
      secondResult.expect.containsFunctionCall({ name: 'record_name' });
    } finally {
      await session.close().catch(() => {});
    }
  });
});
