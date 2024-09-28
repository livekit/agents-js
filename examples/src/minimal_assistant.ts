// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('starting assistant example agent');

    const model = new openai.realtime.RealtimeModel({
      instructions: 'You are a helpful assistant.',
    });

    const agent = new multimodal.MultimodalAgent({
      model,
      fncCtx: {
        weather: {
          description: 'Get the weather in a location',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => {
            console.debug(`executing weather function for ${location}`);
            return await fetch(`https://wttr.in/${location}?format=%C+%t`)
              .then((data) => data.text())
              .then((data) => `The weather in ${location} right now is ${data}.`);
          },
        },
      },
    });

    await agent.start(ctx.room);

    // assistant.addUserMessage('Hello! Can you share a very short story?');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
