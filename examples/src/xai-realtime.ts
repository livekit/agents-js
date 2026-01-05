// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, ServerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions: 'You are a helpful assistant. Keep your responses short and concise.',
      tools: {
        getWeather: llm.tool({
          description: 'Get the weather for a given location.',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => {
            return `The weather in ${location} is sunny.`;
          },
        }),
      },
    });

    const session = new voice.AgentSession({
      llm: new xai.realtime.RealtimeModel(),
    });

    await session.start({
      agent,
      room: ctx.room,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
