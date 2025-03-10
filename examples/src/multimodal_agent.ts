// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, llm, multimodal } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);

    let model: openai.realtime.RealtimeModel;

    if (process.env.AZURE_OPENAI_ENDPOINT) {
      model = openai.realtime.RealtimeModel.withAzure({
        baseURL: process.env.AZURE_OPENAI_ENDPOINT,
        azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || '',
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        entraToken: process.env.AZURE_OPENAI_ENTRA_TOKEN,
        instructions: 'You are a helpful assistant.',
      });
    } else {
      model = new openai.realtime.RealtimeModel({
        instructions: 'You are a helpful assistant.',
      });
    }

    const fncCtx: llm.FunctionContext = {
      weather: {
        description: 'Get the weather in a location',
        parameters: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: async ({ location }) => {
          console.debug(`executing weather function for ${location}`);
          const response = await fetch(`https://wttr.in/${location}?format=%C+%t`);
          if (!response.ok) {
            throw new Error(`Weather API returned status: ${response.status}`);
          }
          const weather = await response.text();
          return `The weather in ${location} right now is ${weather}.`;
        },
      },
    };

    const agent = new multimodal.MultimodalAgent({
      model,
      fncCtx,
    });

    const session = await agent
      .start(ctx.room, participant)
      .then((session) => session as openai.realtime.RealtimeSession);

    session.conversation.item.create(
      llm.ChatMessage.create({
        role: llm.ChatRole.USER,
        text: 'Say "How can I help you today?"',
      }),
    );
    session.response.create();
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
