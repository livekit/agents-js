// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { VoiceAssistant, defaultConversationConfig } from '@livekit/agents-plugin-openai';
import { z } from 'zod';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('starting assistant example agent');

    const assistant = new VoiceAssistant({
      conversationConfig: {
        ...defaultConversationConfig,
        system_message: 'You are a helpful assistant.',
      },
      functions: {
        weather: {
          description: 'Get the weather in a location',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => ({
            location,
            temperature: await fetch(`https://wttr.in/${location}?format=%C+%t`).then((data) =>
              data.text(),
            ),
            source: 'wttr.in',
          }),
        },
      },
    });

    await assistant.start(ctx.room);

    assistant.addUserMessage('Hello! Can you share a very short story?');
  },
});

// check that we're running this file and not importing functions from it
// without this if closure, our code would start` a new Agents process on every job process.
if (process.argv[1] === import.meta.filename) {
  cli.runApp(new WorkerOptions({ agent: import.meta.filename }));
}
