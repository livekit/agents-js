// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, ServerOptions, cli, defineAgent, llm, log, voice } from '@livekit/agents';
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

const scheduleDelivery = llm.tool({
  name: 'scheduleDelivery',
  description: 'Book a delivery day for an order.',
  parameters: z.object({ orderId: z.string(), day: z.string() }),
  execute: async ({ orderId, day }) =>
    orders[orderId.toUpperCase()]
      ? `Delivery for order ${orderId} is booked for ${day}.`
      : `I cannot find order ${orderId}, so I did not schedule anything.`,
});

function priorConversation(): llm.ChatContext {
  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({ role: 'user', content: 'Hi, I ordered a standing desk last week.' });
  chatCtx.addMessage({
    role: 'assistant',
    content: 'Thanks for calling. I have your order A1042 on file.',
  });
  chatCtx.addMessage({ role: 'user', content: 'I had to run, I will call back about delivery.' });
  return chatCtx;
}

class Assistant extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You are a helpful voice assistant for an online furniture store. Keep replies short and conversational. Do not use emojis, asterisks, or other special characters. Ask before taking any external action.',
      chatCtx: priorConversation(),
      tools: [new openai.WebSearch(), lookupWeather, checkOrderStatus, scheduleDelivery],
    });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply({
      instructions:
        'Welcome the caller back to Acme and ask whether they are calling about the delivery of order A1042.',
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      llm: new openai.realtime.GPTLiveModel({
        voice: 'marin',
        responsesOptions: {
          model: 'gpt-5.6-sol',
          instructions: 'Use tools when current information is required.',
        },
      }),
    });
    ctx.addShutdownCallback(async () => {
      log().info({ usage: session.usage }, 'GPT-Live usage');
    });
    await session.start({ agent: new Assistant(), room: ctx.room });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
