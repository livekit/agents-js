// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { llm } from '@livekit/agents';
import { type JobContext, WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);

    const model = new elevenlabs.realtime.RealtimeModel({
      agentId: 'oYxMlLkXbNtZDS3zCikc', //Placeholder for public agent, no API key required
      audioOptions: {
        sampleRate: 22050,
        inFrameSize: 2205,
        outFrameSize: 1102,
      },
    });

    // This function will not execute, this is just an example,
    // in order to define client tools you need to configure your agent
    // see: https://elevenlabs.io/docs/conversational-ai/customization/tools/client-tools
    const fncCtx: llm.FunctionContext = {
      logMessage: {
        description: 'logMessage',
        parameters: z.object({
          message: z.string(),
        }),
        execute: async ({ message }) => {
          console.debug(`executing logMessage function for ${message}`);
          return `Logged message`;
        },
      },
    };

    const agent = new multimodal.MultimodalAgent({
      model,
      fncCtx,
    });

    await agent
      .start(ctx.room, participant)
      .then((session) => session as elevenlabs.realtime.RealtimeSession);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
