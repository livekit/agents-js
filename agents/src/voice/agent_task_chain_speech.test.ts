// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { TaskGroup } from '../workflows/task_group.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

const GREETING = 'am I speaking with the account holder?';
const ASK_ID = 'could you confirm your ID number?';
const CLOSING = 'thank you, transferring you now.';

class GreetingTask extends AgentTask<null> {
  constructor() {
    super({
      instructions: 'greeting',
      tools: [
        tool({
          name: 'holder',
          description: 'Called when the user confirms they are the account holder.',
          execute: async () => {
            this.complete(null);
            return 'ok';
          },
        }),
      ],
    });
  }

  async onEnter(): Promise<void> {
    await this.session.say(GREETING).waitForPlayout();
  }
}

class IdTask extends AgentTask<null> {
  constructor() {
    super({
      instructions: 'id',
      tools: [
        tool({
          name: 'confirmed',
          description: 'Called when the user confirms the ID number.',
          execute: async () => {
            this.complete(null);
            return 'ok';
          },
        }),
      ],
    });
  }

  async onEnter(): Promise<void> {
    await this.session.say(ASK_ID).waitForPlayout();
  }
}

class Closing extends Agent {
  constructor() {
    super({ instructions: 'closing' });
  }

  async onEnter(): Promise<void> {
    await this.session.say(CLOSING).waitForPlayout();
  }
}

class ChainedEntry extends Agent {
  constructor() {
    super({ instructions: 'entry' });
  }

  async onEnter(): Promise<void> {
    await new GreetingTask().run();
    await new IdTask().run();
    this.session.updateAgent(new Closing());
  }
}

class GroupedEntry extends Agent {
  constructor() {
    super({ instructions: 'entry' });
  }

  async onEnter(): Promise<void> {
    await new TaskGroup({ summarizeChatCtx: false })
      .add(() => new GreetingTask(), { id: 'greeting', description: 'greet the user' })
      .add(() => new IdTask(), { id: 'id', description: 'confirm the id number' })
      .run();
    this.session.updateAgent(new Closing());
  }
}

function buildFakeLLM(): FakeLLM {
  return new FakeLLM([
    {
      input: 'yes, speaking',
      content: '',
      ttft: 100,
      duration: 100,
      toolCalls: [{ name: 'holder', args: {} }],
    },
    {
      input: 'yes, that is right',
      content: '',
      ttft: 100,
      duration: 100,
      toolCalls: [{ name: 'confirmed', args: {} }],
    },
    { input: 'ok', content: '', ttft: 100, duration: 100 },
  ]);
}

// the start-time handoff into the first task is still in flight when start() resolves
async function spoken(session: AgentSession, text: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (
      session.history.items.some((item) => item.type === 'message' && item.textContent === text)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${text} was never spoken`);
}

function messages(result: { events: { type: string; item: unknown }[] }): (string | undefined)[] {
  return result.events
    .filter((event) => event.type === 'message')
    .map((event) => (event.item as { textContent?: string }).textContent);
}

describe('a run records the speech of the next AgentTask in a chain', () => {
  it.each([
    ['awaited one after another', () => new ChainedEntry()],
    ['in a TaskGroup', () => new GroupedEntry()],
  ])(
    '%s',
    async (_name, entry) => {
      const session = new AgentSession({
        llm: buildFakeLLM(),
        vad: null,
        turnHandling: { turnDetection: null },
      });
      await session.start({ agent: entry() });
      try {
        await spoken(session, GREETING);

        let result = await session.run({ userInput: 'yes, speaking' }).wait();
        result.expect.nextEvent().isFunctionCall({ name: 'holder' });
        result.expect.nextEvent().isFunctionCallOutput();
        expect(messages(result)).toEqual([ASK_ID]);

        result = await session.run({ userInput: 'yes, that is right' }).wait();
        result.expect.nextEvent().isFunctionCall({ name: 'confirmed' });
        result.expect.nextEvent().isFunctionCallOutput();
        result.expect.containsAgentHandoff({ newAgentType: Closing });
        expect(messages(result)).toEqual([CLOSING]);
      } finally {
        await session.close().catch(() => {});
      }
    },
    10_000,
  );
});
