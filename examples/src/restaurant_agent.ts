// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { z } from 'zod';

const logger: Logger | null = null;

type UserData = {
  customer: Partial<{
    name: string;
    phone: string;
  }>;
  creditCard: Partial<{
    number: string;
    expiry: string;
    cvv: string;
  }>;
  reservationTime?: string;
  order?: string[];
  expense?: number;
  checkedOut?: boolean;
  agents: Record<string, voice.Agent<UserData>>;
  prevAgent?: voice.Agent<UserData>;
};

function summarize({
  customer,
  reservationTime,
  order,
  creditCard,
  expense,
  checkedOut,
}: UserData) {
  return JSON.stringify(
    {
      customer: customer.name ?? 'unknown',
      customerPhone: customer.phone ?? 'unknown',
      reservationTime: reservationTime ?? 'unknown',
      order: order ?? 'unknown',
      creditCard: creditCard
        ? {
            number: creditCard.number ?? 'unknown',
            expiry: creditCard.expiry ?? 'unknown',
            cvv: creditCard.cvv ?? 'unknown',
          }
        : undefined,
      expense: expense ?? 'unknown',
      checkedOut: checkedOut ?? false,
    },
    null,
    2,
  );
}

const updateName = llm.tool({
  description:
    'Called when the user provides their name. Confirm the spelling with the user before calling the function.',
  parameters: z.object({
    name: z.string().describe('The customer name'),
  }),
  execute: async ({ name }, { ctx }: llm.ToolOptions<UserData>) => {
    ctx.userData.customer.name = name;
    return `The name is updated to ${name}`;
  },
});

const updatePhone = llm.tool({
  description:
    'Called when the user provides their phone number. Confirm the spelling with the user before calling the function.',
  parameters: z.object({
    phone: z.string().describe('The customer phone number'),
  }),
  execute: async ({ phone }, { ctx }: llm.ToolOptions<UserData>) => {
    ctx.userData.customer.phone = phone;
    return `The phone number is updated to ${phone}`;
  },
});

const toGreeter = llm.tool({
  description:
    'Called when user asks any unrelated questions or requests any other services not in your job description.',
  parameters: z.object({}),
  execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
    ctx.userData.prevAgent = ctx.session.currentAgent;
    return llm.handoff({
      agent: ctx.userData.agents.greeter,
      returns: 'The greeter is now playing.',
    });
  },
});

class BaseAgent extends voice.Agent {
  async onEnter(): Promise<void> {
    const agentName = this.constructor.name;
    console.log(`entering task ${agentName}`);

    const userdata: UserData = this.session.userData;
    const chatCtx = this.chatCtx.copy();

    if (userdata.prevAgent) {
    }
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
    });
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    console.log('participant joined: ', participant.identity);

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      llm: new openai.LLM(),
      tts: new elevenlabs.TTS(),
    });
    await session.start(agent, ctx.room);
    session.say('Hello, how are you? My name is LiveKit Agents');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
