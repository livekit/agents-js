// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  voice,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const orders: Record<string, string> = {
  A1042: 'shipped, arriving Thursday',
  B2231: 'still being packed',
};

const checkOrderStatus = llm.tool({
  name: 'checkOrderStatus',
  description: 'Check the delivery status of an order.',
  parameters: z.object({ orderId: z.string().describe('The order reference, such as A1042.') }),
  execute: async ({ orderId }) => {
    const status = orders[orderId.toUpperCase()];
    return status ? `Order ${orderId} is ${status}.` : `There is no order ${orderId}.`;
  },
});

const lookupWeather = llm.tool({
  name: 'lookupWeather',
  description: 'Look up the current weather for a location.',
  parameters: z.object({ location: z.string().describe('The city or region to look up.') }),
  execute: async ({ location }) => `The weather in ${location} is 62 degrees and partly cloudy.`,
});

const deskTools = new llm.ToolContext([checkOrderStatus, lookupWeather]);
const deskInstructions =
  'You are the order desk for an online furniture store. You never speak to the caller; the voice agent does. Work out what is true, use your tools, and answer in one or two plain sentences the voice agent can say out loud. State facts, not phrasing: no greetings, no "tell them that", no markdown. If a tool cannot answer, say so plainly.';

async function runDelegation(
  model: llm.LLM,
  chatCtx: llm.ChatContext,
  signal: AbortSignal,
): Promise<string> {
  for (let round = 0; round < 4; round++) {
    signal.throwIfAborted();
    let text = '';
    const calls: llm.FunctionCall[] = [];
    const stream = model.chat({ chatCtx, toolCtx: deskTools });
    const abort = () => stream.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of stream) {
        text += chunk.delta?.content ?? '';
        for (const call of chunk.delta?.toolCalls ?? [])
          calls.push(
            new llm.FunctionCall({ callId: call.callId, name: call.name, args: call.args }),
          );
      }
    } finally {
      signal.removeEventListener('abort', abort);
      stream.close();
    }
    signal.throwIfAborted();
    if (!calls.length) return text.trim() || 'I could not work that out.';
    chatCtx.insert(calls);
    for (const call of calls) {
      signal.throwIfAborted();
      chatCtx.insert(await llm.executeToolCall(call, deskTools));
    }
  }
  return 'I could not work that out in time.';
}

class Assistant extends voice.Agent {
  private readonly desk = new inference.LLM({ model: 'openai/gpt-5.5' });
  private readonly tasks = new Map<Promise<void>, AbortController>();
  private live?: openai.realtime.GPTLiveSession;

  constructor() {
    super({
      instructions:
        'You are a helpful voice assistant for an online furniture store. Keep replies short and conversational. Do not use emojis, asterisks, or other special characters.',
    });
  }

  async onEnter(): Promise<void> {
    const live = this.duplexSession;
    if (!(live instanceof openai.realtime.GPTLiveSession))
      throw new Error('Expected GPTLiveSession');
    this.live = live;
    live.on('delegation_created', this.onDelegation);
    this.session.generateReply({
      instructions: 'Greet the caller and ask what you can help them with.',
    });
  }

  async onExit(): Promise<void> {
    this.live?.off('delegation_created', this.onDelegation);
    for (const controller of this.tasks.values()) controller.abort();
    await Promise.all(this.tasks.keys());
  }

  private readonly onDelegation = (delegation: openai.realtime.GPTLiveDelegation): void => {
    const controller = new AbortController();
    const task = this.answer(delegation, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted)
          log().error({ error, delegationId: delegation.id }, 'Client delegation failed');
      })
      .finally(() => {
        this.tasks.delete(task);
      });
    this.tasks.set(task, controller);
  };

  private async answer(
    delegation: openai.realtime.GPTLiveDelegation,
    signal: AbortSignal,
  ): Promise<void> {
    const chatCtx = llm.ChatContext.empty();
    chatCtx.addMessage({ role: 'system', content: deskInstructions });
    chatCtx.items.push(
      ...this.chatCtx.copy({
        excludeFunctionCall: true,
        excludeConfigUpdate: true,
        excludeInstructions: true,
      }).items,
    );
    if (delegation.pendingTranscript)
      chatCtx.addMessage({ role: 'user', content: delegation.pendingTranscript });
    const answer = await runDelegation(this.desk, chatCtx, signal);
    signal.throwIfAborted();
    this.live?.appendCommentary(answer, { delegationId: delegation.id });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      llm: new openai.realtime.GPTLiveModel({ voice: 'marin', delegation: 'client' }),
    });
    await session.start({ agent: new Assistant(), room: ctx.room });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
