// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// A typed line sent over the session host (`lk console` text mode, text simulations)
// stands in for a spoken turn, so it runs what a spoken turn runs: the final transcript
// and onUserTurnCompleted before the reply. An agent that hands work off from those hooks
// then behaves the same typed as it does on a call.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ChatContext, ChatMessage } from '../../llm/chat_context.js';
import { initializeLogger } from '../../log.js';
import { Agent, StopResponse } from '../agent.js';
import { AgentSession } from '../agent_session.js';
import {
  AgentSessionEventTypes,
  type SpeechCreatedEvent,
  type UserInputTranscribedEvent,
} from '../events.js';
import { FakeLLM } from './fake_llm.js';

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

const CART_NOTE = 'the order taker added: two calzones';

/** Hands the order to a background taker from the user-turn hook, the way an agent
 * does when a second model owns the cart. */
class OrderAgent extends Agent {
  turns: string[] = [];

  constructor(
    private behavior: 'note' | 'stop' | 'throw' = 'note',
    private gate?: Promise<void>,
  ) {
    super({ instructions: 'take the order' });
  }

  override async onUserTurnCompleted(turnCtx: ChatContext, newMessage: ChatMessage) {
    this.turns.push(newMessage.textContent ?? '');
    await this.gate;
    if (this.behavior === 'stop') throw new StopResponse();
    if (this.behavior === 'throw') throw new Error('order index unavailable');
    turnCtx.addMessage({ role: 'system', content: CART_NOTE });
  }
}

/** Records the context of every request, to see what the hook put in it. */
class RecordingLLM extends FakeLLM {
  contexts: ChatContext[] = [];

  override chat(params: Parameters<FakeLLM['chat']>[0]) {
    this.contexts.push(params.chatCtx);
    return super.chat(params);
  }
}

async function runTyped(agent: OrderAgent, text: string) {
  const llm = new RecordingLLM([{ input: text, content: 'Two calzones. Anything else?' }]);
  const session = new AgentSession({ llm });
  const transcripts: string[] = [];
  const modalities: string[] = [];
  session.on(AgentSessionEventTypes.SpeechCreated, (ev: SpeechCreatedEvent) => {
    modalities.push(ev.speechHandle.inputDetails.modality);
  });
  session.on(AgentSessionEventTypes.UserInputTranscribed, (ev: UserInputTranscribedEvent) => {
    if (ev.isFinal) transcripts.push(ev.transcript);
  });
  await session.start({ agent });
  try {
    const run = session._runTypedUserTurn(text);
    await run.wait();
    const said = run.events
      .map((ev) => ev.item)
      .filter((item): item is ChatMessage => item.type === 'message' && item.role === 'assistant')
      .map((item) => item.textContent);
    const seen = llm.contexts.map((ctx) =>
      ctx.items.some((item) => item.type === 'message' && item.textContent === CART_NOTE),
    );
    return { said, transcripts, seen, modalities };
  } finally {
    await session.close().catch(() => {});
  }
}

describe('typed user turn', () => {
  it('runs the user-turn hooks before the reply', async () => {
    const agent = new OrderAgent();

    const { said, transcripts, seen, modalities } = await runTyped(agent, 'two calzones please');

    expect(agent.turns).toEqual(['two calzones please']);
    expect(transcripts).toEqual(['two calzones please']);
    // the reply was generated from the context the hook edited
    expect(seen).toEqual([true]);
    expect(said).toEqual(['Two calzones. Anything else?']);
    // typed input answers with the agent's text instructions
    expect(modalities).toEqual(['text']);
    // the turn is still the user's: their message lands in the history once
    const users = agent.chatCtx.items.filter(
      (item) => item.type === 'message' && item.role === 'user',
    ) as ChatMessage[];
    expect(users.map((m) => m.textContent)).toEqual(['two calzones please']);
  });

  it('treats StopResponse as a silent turn', async () => {
    const agent = new OrderAgent('stop');

    const { said } = await runTyped(agent, 'two calzones please');

    expect(agent.turns).toEqual(['two calzones please']);
    expect(said).toEqual([]);
  });

  it('still answers when the hook fails, as a spoken turn does', async () => {
    const agent = new OrderAgent('throw');

    const { said } = await runTyped(agent, 'two calzones please');

    expect(agent.turns).toEqual(['two calzones please']);
    expect(said).toEqual(['Two calzones. Anything else?']);
  });

  it('does not answer a run cancelled while the hook ran', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const agent = new OrderAgent('note', gate);
    const llm = new RecordingLLM([
      { input: 'two calzones please', content: 'Two calzones. Anything else?' },
    ]);
    const session = new AgentSession({ llm });
    await session.start({ agent });
    try {
      const run = session._runTypedUserTurn('two calzones please');
      await expect.poll(() => agent.turns.length).toBe(1);
      const cancelled = run._cancel();
      await expect(run.wait()).rejects.toThrow();
      release();
      await cancelled;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(llm.contexts).toEqual([]);
    } finally {
      await session.close().catch(() => {});
    }
  });
});
