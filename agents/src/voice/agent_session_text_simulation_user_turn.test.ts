// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatContext, ChatMessage } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import { Agent, StopResponse } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

class HookAgent extends Agent {
  turns: string[] = [];

  constructor(private readonly hook: (message: ChatMessage) => void) {
    super({
      instructions: 'help the user',
      llm: new FakeLLM([
        { input: 'hello there', content: 'unedited' },
        { input: 'edited', content: 'edited' },
      ]),
    });
  }

  async onUserTurnCompleted(_chatCtx: ChatContext, newMessage: ChatMessage): Promise<void> {
    this.turns.push(newMessage.textContent ?? '');
    this.hook(newMessage);
  }
}

// The simulator drives each user turn through session.run().
const runTurn = async (agent: HookAgent, textOnly: boolean): Promise<string[]> => {
  vi.spyOn(AgentSession.prototype, '_textOnly', 'get').mockReturnValue(textOnly);
  const session = new AgentSession({});
  try {
    await session.start({ agent });
    const result = await session.run({ userInput: 'hello there' }).wait();
    return result.events.flatMap((ev) =>
      ev.item.type === 'message' ? [ev.item.textContent ?? ''] : [],
    );
  } finally {
    await session.close();
  }
};

const editTo = (text: string) => (message: ChatMessage) => {
  message.content = [text];
};

describe('text simulation user turns', () => {
  it('runs onUserTurnCompleted and replies with its edits', async () => {
    const agent = new HookAgent(editTo('edited'));
    const replies = await runTurn(agent, true);

    expect(agent.turns).toEqual(['hello there']);
    expect(replies).toEqual(['edited']);
  });

  it('settles the run without a reply on StopResponse', async () => {
    const agent = new HookAgent(() => {
      throw new StopResponse();
    });
    const replies = await runTurn(agent, true);

    expect(agent.turns).toEqual(['hello there']);
    expect(replies).toEqual([]);
  });

  it('skips the hook outside a text simulation', async () => {
    const agent = new HookAgent(editTo('edited'));
    const replies = await runTurn(agent, false);

    expect(agent.turns).toEqual([]);
    expect(replies).toEqual(['unedited']);
  });

  it.each([true, false])('sends no reply after the hook hands off (wait=%s)', async (wait) => {
    // the turn's reply was built from the old agent's context: neither agent may answer it
    const asked: string[] = [];
    class RecordingLLM extends FakeLLM {
      constructor(private readonly owner: string) {
        super();
      }
      override chat(params: Parameters<FakeLLM['chat']>[0]) {
        asked.push(this.owner);
        return super.chat(params);
      }
    }
    const next = new Agent({ instructions: 'next agent', llm: new RecordingLLM('next') });
    class HandoffAgent extends Agent {
      constructor() {
        super({ instructions: 'help the user', llm: new RecordingLLM('old') });
      }
      async onUserTurnCompleted(): Promise<void> {
        this.session.updateAgent(next);
        if (wait) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    vi.spyOn(AgentSession.prototype, '_textOnly', 'get').mockReturnValue(true);
    const session = new AgentSession({});
    try {
      await session.start({ agent: new HandoffAgent() });
      await session.run({ userInput: 'hello there' }).wait();
      expect(asked).toEqual([]);
      expect(session.currentAgent).toBe(next);
    } finally {
      await session.close();
    }
  });
});
