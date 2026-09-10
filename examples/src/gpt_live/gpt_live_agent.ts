// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, ServerOptions, cli, defineAgent, llm, log, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';
import { checkOrderStatus, lookupWeather, scheduleDelivery } from './tools.js';

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
