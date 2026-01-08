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
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
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

    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant created by LiveKit, always speaking English, you can hear the user's message and respond to it.",
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
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
