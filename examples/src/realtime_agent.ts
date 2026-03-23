// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const roomNameSchema = z.enum(['bedroom', 'living room', 'kitchen', 'bathroom', 'office']);

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

    const chatCtx = new llm.ChatContext();

    const sampleImageBase64 = readFileSync(
      new URL('../assets/walking-dogs.png', import.meta.url),
    ).toString('base64');

    // realtime LLM with image input
    chatCtx.addMessage({
      role: 'user',
      content: [
        llm.createImageContent({
          image: `data:image/png;base64,${sampleImageBase64}`,
          mimeType: 'image/png',
        }),
      ],
    });

    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant created by LiveKit, always speaking English, you can hear the user's message and respond to it.",
      chatCtx,
      tools: {
        getWeather,
        toggleLight,
      },
    });

    const session = new voice.AgentSession({
      // llm: new openai.realtime.beta.RealtimeModel(),
      llm: new openai.realtime.RealtimeModel(),
      // enable to allow chaining of tool calls
      voiceOptions: {
        maxToolSteps: 5,
      },
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      console.log('metrics_collected', ev);
    });

    session.generateReply({
      instructions: 'Describe this image.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
