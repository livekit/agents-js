// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, ServerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as phonic from '@livekit/agents-plugin-phonic';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const toggleLight = llm.tool({
  description: 'Toggle a light on or off. Available lights are A05, A06, A07, and A08.',
  parameters: z.object({
    light_id: z.string().describe('The ID of the light to toggle'),
    state: z.enum(['on', 'off']).describe('Whether to turn the light on or off'),
  }),
  execute: async ({ light_id, state }) => {
    console.log(`Turning ${state} light ${light_id}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return `Light ${light_id} turned ${state}`;
  },
});

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions: 'You are a helpful voice AI assistant named Alex.',
      tools: {
        toggle_light: toggleLight,
      },
    });

    const session = new voice.AgentSession({
      // Uses PHONIC_API_KEY environment variable when apiKey is not provided
      llm: new phonic.realtime.RealtimeModel({
        voice: 'sabrina',
        welcomeMessage: 'Hey there, how can I help you today?',
        audioSpeed: 1.2,
      }),
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    await ctx.connect();
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
