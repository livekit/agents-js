// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ChatMessage, type MetricsReport } from '../llm/chat_context.js';
import { handoff, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';
import { FakeLLM, type FakeLLMResponse } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

class Greeter extends Agent {
  constructor() {
    super({ instructions: 'greeter' });
  }

  override async onEnter(): Promise<void> {
    this.session.generateReply({ instructions: 'instructions:greet' });
  }
}

function handoffCall(execute: () => unknown | Promise<unknown>) {
  return tool({
    name: 'handoff',
    description: 'Transfer to another agent.',
    parameters: z.object({}),
    execute,
  });
}

async function startScenario(agent: Agent, responses: FakeLLMResponse[]) {
  const session = new AgentSession({ llm: new FakeLLM(responses) });
  const messages: ChatMessage[] = [];
  session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
    if (ev.item.type === 'message') messages.push(ev.item);
  });
  await session.start({ agent });
  return { session, messages };
}

function commitUserTurn(session: AgentSession, text: string): void {
  const now = Date.now();
  session.generateReply({
    userInput: ChatMessage.create({
      role: 'user',
      content: text,
      metrics: {
        startedSpeakingAt: (now - 2_000) / 1_000,
        stoppedSpeakingAt: (now - 1_000) / 1_000,
      },
    }),
    inputModality: 'text',
  });
}

async function waitForMessages(messages: ChatMessage[], count: number): Promise<void> {
  await vi.waitFor(() => expect(messages).toHaveLength(count), { timeout: 5_000 });
}

async function waitForAgent(session: AgentSession, type: abstract new (...args: never[]) => Agent) {
  await vi.waitFor(() => expect(session.currentAgent).toBeInstanceOf(type), { timeout: 5_000 });
}

function byRole(messages: ChatMessage[], role: 'user' | 'assistant'): ChatMessage[] {
  return messages.filter((message) => message.role === role);
}

function assertAnswers(assistant: ChatMessage, user: ChatMessage): void {
  const assistantMetrics = assistant.metrics as MetricsReport;
  const userMetrics = user.metrics as MetricsReport;
  expect(assistantMetrics.e2eLatency).toBeCloseTo(
    assistantMetrics.startedSpeakingAt! - userMetrics.stoppedSpeakingAt!,
  );
}

describe('AgentActivity e2e latency across handoffs', () => {
  it('reports e2e latency on a handoff reply', async () => {
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new Greeter() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'hello from the greeter' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 2);
      const [user] = byRole(messages, 'user');
      const [greeting] = byRole(messages, 'assistant');
      expect(greeting!.textContent).toBe('hello from the greeter');
      assertAnswers(greeting!, user!);
    } finally {
      await session.close();
    }
  });

  it('reports e2e latency when a tool calls updateAgent', async () => {
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => this.session.updateAgent(new Greeter()))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'hello from the greeter' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 2);
      assertAnswers(byRole(messages, 'assistant')[0]!, byRole(messages, 'user')[0]!);
    } finally {
      await session.close();
    }
  });

  it('uses speech before a handoff as the answer', async () => {
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new Greeter() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', content: 'let me transfer you', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'hello from the greeter' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 3);
      const [transfer, greeting] = byRole(messages, 'assistant');
      assertAnswers(transfer!, byRole(messages, 'user')[0]!);
      expect(greeting!.metrics?.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('uses a tool reply before a handoff as the answer', async () => {
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new Greeter(), returns: 'transferring' }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: '"transferring"', content: 'transferring you now' },
      { input: 'instructions:greet', content: 'hello from the greeter' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 3);
      const [toolReply, greeting] = byRole(messages, 'assistant');
      assertAnswers(toolReply!, byRole(messages, 'user')[0]!);
      expect(greeting!.metrics?.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('uses say in onEnter as the answer', async () => {
    class SayGreeter extends Agent {
      constructor() {
        super({ instructions: 'say greeter' });
      }
      override async onEnter(): Promise<void> {
        await this.session.say('welcome');
        this.session.generateReply({ instructions: 'instructions:greet' });
      }
    }
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new SayGreeter() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'how can I help' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 3);
      const [welcome, reply] = byRole(messages, 'assistant');
      assertAnswers(welcome!, byRole(messages, 'user')[0]!);
      expect(reply!.metrics?.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('reports the turn only once for concurrent onEnter speeches', async () => {
    class DoubleGreeter extends Agent {
      constructor() {
        super({ instructions: 'double greeter' });
      }
      override async onEnter(): Promise<void> {
        void this.session.say('welcome');
        this.session.generateReply({ instructions: 'instructions:greet' });
      }
    }
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new DoubleGreeter() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'how can I help' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 3);
      const [welcome, reply] = byRole(messages, 'assistant');
      assertAnswers(welcome!, byRole(messages, 'user')[0]!);
      expect(reply!.metrics?.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('settles the turn for an unstored say in onEnter', async () => {
    class QuietGreeter extends Agent {
      constructor() {
        super({ instructions: 'quiet greeter' });
      }
      override async onEnter(): Promise<void> {
        await this.session.say('welcome', { addToChatCtx: false });
        this.session.generateReply({ instructions: 'instructions:greet' });
      }
    }
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new QuietGreeter() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'how can I help' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 2);
      expect(byRole(messages, 'assistant')[0]!.metrics?.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('reports e2e latency for a nested handoff in onEnter', async () => {
    class AskName extends AgentTask<void> {
      constructor() {
        super({
          instructions: 'ask name',
          tools: [
            tool({
              name: 'record_name',
              description: 'Record the name.',
              parameters: z.object({ name: z.string() }),
              execute: () => this.complete(undefined),
            }),
          ],
        });
      }
      override async onEnter(): Promise<void> {
        this.session.generateReply({ instructions: 'instructions:ask_name' });
      }
    }
    class Survey extends Agent {
      constructor() {
        super({ instructions: 'survey' });
      }
      override async onEnter(): Promise<void> {
        await new AskName().run();
      }
    }
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new Survey() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:ask_name', content: 'what is your name?' },
      { input: 'Bob', toolCalls: [{ name: 'record_name', args: { name: 'Bob' } }] },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 2);
      await commitUserTurn(session, 'Bob');
      await waitForMessages(messages, 3);
      assertAnswers(byRole(messages, 'assistant')[0]!, byRole(messages, 'user')[0]!);
    } finally {
      await session.close();
    }
  });

  it('does not report a turn for a task spawned by onEnter that speaks later', async () => {
    class LateGreeter extends Agent {
      constructor() {
        super({ instructions: 'late greeter' });
      }
      override async onEnter(): Promise<void> {
        setTimeout(() => this.session.generateReply({ instructions: 'instructions:greet' }), 20);
      }
    }
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new LateGreeter() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'hello from the greeter' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 2);
      expect(byRole(messages, 'assistant')[0]!.metrics?.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('lets a new user turn supersede the handoff turn', async () => {
    class LateGreeter extends Agent {
      constructor() {
        super({ instructions: 'late greeter' });
      }
      override async onEnter(): Promise<void> {
        setTimeout(() => this.session.generateReply({ instructions: 'instructions:greet' }), 300);
      }
    }
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new LateGreeter() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'hello again', content: 'hi again' },
      { input: 'instructions:greet', content: 'hello from the greeter' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForAgent(session, LateGreeter);
      await commitUserTurn(session, 'hello again');
      await waitForMessages(messages, 4);
      const [, again] = byRole(messages, 'user');
      const [reply, greeting] = byRole(messages, 'assistant');
      assertAnswers(reply!, again!);
      expect(greeting!.metrics?.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('reports each turn around an inline task in a tool', async () => {
    class AskEmail extends AgentTask<string> {
      constructor() {
        super({
          instructions: 'ask email',
          tools: [
            tool({
              name: 'record_email',
              description: 'Record the email.',
              parameters: z.object({ email: z.string() }),
              execute: ({ email }) => this.complete(email),
            }),
          ],
        });
      }
      override async onEnter(): Promise<void> {
        this.session.generateReply({ instructions: 'instructions:ask_email' });
      }
    }
    class Booker extends Agent {
      constructor() {
        super({
          instructions: 'booker',
          tools: [
            tool({
              name: 'book',
              description: 'Book a room.',
              parameters: z.object({}),
              execute: async () => `booked for ${await new AskEmail().run()}`,
            }),
          ],
        });
      }
    }

    const { session, messages } = await startScenario(new Booker(), [
      { input: 'book a room', toolCalls: [{ name: 'book', args: {} }] },
      { input: 'instructions:ask_email', content: 'what is your email?' },
      { input: 'a@b.com', toolCalls: [{ name: 'record_email', args: { email: 'a@b.com' } }] },
      { input: '"booked for a@b.com"', content: 'your room is booked' },
    ]);
    try {
      await commitUserTurn(session, 'book a room');
      await waitForMessages(messages, 2);
      await commitUserTurn(session, 'a@b.com');
      await waitForMessages(messages, 4);
      const [book, email] = byRole(messages, 'user');
      const [question, confirmation] = byRole(messages, 'assistant');
      assertAnswers(question!, book!);
      assertAnswers(confirmation!, email!);
    } finally {
      await session.close();
    }
  });

  it('ends the turn after a silent tool', async () => {
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [
            handoffCall(() => {
              setTimeout(() => this.session.updateAgent(new Greeter()), 20);
            }),
          ],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'hello from the greeter' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 2);
      expect(byRole(messages, 'assistant')[0]!.metrics?.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('ends the turn after a silent onEnter', async () => {
    class Silent extends Agent {
      constructor() {
        super({ instructions: 'silent' });
      }
      override async onEnter(): Promise<void> {
        setTimeout(() => this.session.updateAgent(new Greeter()), 20);
      }
    }
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new Silent() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'hello from the greeter' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 2);
      expect(byRole(messages, 'assistant')[0]!.metrics?.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('reports the last turn after an awaited task in onEnter', async () => {
    class AskName extends AgentTask<string> {
      constructor() {
        super({
          instructions: 'ask name',
          tools: [
            tool({
              name: 'record_name',
              description: 'Record the name.',
              parameters: z.object({ name: z.string() }),
              execute: ({ name }) => this.complete(name),
            }),
          ],
        });
      }
      override async onEnter(): Promise<void> {
        this.session.generateReply({ instructions: 'instructions:ask_name' });
      }
    }
    class Survey extends Agent {
      constructor() {
        super({ instructions: 'survey' });
      }
      override async onEnter(): Promise<void> {
        const name = await new AskName().run();
        this.session.generateReply({ instructions: `instructions:thank ${name}` });
      }
    }
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new Survey() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:ask_name', content: 'what is your name?' },
      { input: 'Bob', toolCalls: [{ name: 'record_name', args: { name: 'Bob' } }] },
      { input: 'instructions:thank Bob', content: 'thanks Bob' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForMessages(messages, 2);
      await commitUserTurn(session, 'Bob');
      await waitForMessages(messages, 4);
      const [go, bob] = byRole(messages, 'user');
      const [question, thanks] = byRole(messages, 'assistant');
      assertAnswers(question!, go!);
      assertAnswers(thanks!, bob!);
    } finally {
      await session.close();
    }
  });

  it('preserves a turn committed while onEnter is running', async () => {
    class Slow extends Agent {
      constructor() {
        super({
          instructions: 'slow',
          tools: [handoffCall(() => handoff({ agent: new Greeter() }))],
        });
      }
      override async onEnter(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    class Router extends Agent {
      constructor() {
        super({
          instructions: 'router',
          tools: [handoffCall(() => handoff({ agent: new Slow() }))],
        });
      }
    }

    const { session, messages } = await startScenario(new Router(), [
      { input: 'go', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'support please', toolCalls: [{ name: 'handoff', args: {} }] },
      { input: 'instructions:greet', content: 'hello from the greeter' },
    ]);
    try {
      await commitUserTurn(session, 'go');
      await waitForAgent(session, Slow);
      await commitUserTurn(session, 'support please');
      await waitForMessages(messages, 3);
      const [, support] = byRole(messages, 'user');
      assertAnswers(byRole(messages, 'assistant')[0]!, support!);
    } finally {
      await session.close();
    }
  });
});
