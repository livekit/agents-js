// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
    type JobContext,
    type JobProcess,
    WorkerOptions,
    cli,
    defineAgent,
    voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { tool } from 'agents/dist/llm/tool_context.js';
import { createAgent } from 'agents/dist/voice/agent.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const roomNameSchema = z.enum(['bedroom', 'living room', 'kitchen', 'bathroom', 'office']);

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const getWeather = tool({
      description: ' Called when the user asks about the weather.',
      parameters: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => {
        return `The weather in ${location} is sunny today.`;
      },
    });

    const toggleLight = tool({
      description: 'Called when the user asks to turn on or off the light.',
      parameters: z.object({
        room: roomNameSchema.describe('The room to turn the light in'),
        switchTo: z.enum(['on', 'off']).describe('The state to turn the light to'),
      }),
      execute: async ({ room, switchTo }) => {
        return `The light in the ${room} is now ${switchTo}.`;
      },
    });

    const getNumber = tool({
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

    const agent = createAgent({
      instructions: 'You are a helpful assistant.',
      tools: { getWeather, toggleLight, getNumber },
    });
    
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    console.log('participant joined: ', participant.identity);

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession(
      vad,
      new deepgram.STT(),
      new openai.LLM(),
      new elevenlabs.TTS(),
    );
    session.start(agent, ctx.room);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
