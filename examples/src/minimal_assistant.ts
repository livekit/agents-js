// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { OmniAssistant, defaultSessionConfig } from '@livekit/agents-plugin-openai';
import { z } from 'zod';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('starting assistant example agent');

    const assistant = new OmniAssistant({
      sessionConfig: {
        ...defaultSessionConfig,
        instructions: 'You are a helpful assistant.',
      },
      functions: {
        weather: {
          description: 'Get the weather in a location',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) =>
            await fetch(`https://wttr.in/${location}?format=%C+%t`)
              .then((data) => data.text())
              .then((data) => `The weather in ${location} right now is ${data}.`),
        },
      },
    });

    await assistant.start(ctx.room);

    assistant.addUserMessage('Hello! Can you share a very short story?');
  },
});

cli.runApp(new WorkerOptions({ agent: import.meta.filename }));
