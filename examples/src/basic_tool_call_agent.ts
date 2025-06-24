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
import { z } from 'zod';

const roomNameSchema = z.enum(['bedroom', 'living room', 'kitchen', 'bathroom', 'office']);

type UserData = {
  number: number;
};

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const getWeather = llm.tool({
      description: ' Called when the user asks about the weather.',
      parameters: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => {
        if (Math.random() < 0.5) {
          throw new llm.ToolError('Internal server error, please try again later.');
        }
        return `The weather in ${location} is sunny today.`;
      },
    });

    const toggleLight = llm.tool({
      description: 'Called when the user asks to turn on or off the light.',
      parameters: z.object({
        room: roomNameSchema.describe('The room to turn the light in'),
        switchTo: z.enum(['on', 'off']).describe('The state to turn the light to'),
      }),
      execute: async ({ room, switchTo }) => {
        return `The light in the ${room} is now ${switchTo}.`;
      },
    });

    const getNumber = llm.tool({
      description:
        'Called when the user wants to get a number value, None if user want a random value',
      parameters: z.object({
        value: z.number().optional().describe('The number value'),
      }),
      execute: async ({ value }) => {
        if (value === undefined) {
          value = Math.floor(Math.random() * 100);
        }
        return `The number value is ${value}.`;
      },
    });

    const checkStoredNumber = llm.tool({
      description: 'Called when the user wants to check the stored number.',
      parameters: z.object({}),
      execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
        return `The stored number is ${ctx.userData.number}.`;
      },
    });

    const updateStoredNumber = llm.tool({
      description: 'Called when the user wants to update the stored number.',
      parameters: z.object({
        number: z.number().describe('The number to update the stored number to'),
      }),
      execute: async ({ number }, { ctx }: llm.ToolOptions<UserData>) => {
        ctx.userData.number = number;
        return `The stored number is now ${number}.`;
      },
    });

    const agent = voice.createAgent<UserData>({
      instructions: 'You are a helpful assistant.',
      tools: { getWeather, toggleLight, getNumber, checkStoredNumber, updateStoredNumber },
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
      userData: { number: 0 },
    });
    console.log('session 123 created');
    session.start(agent, ctx.room);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
