// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);

    const model = new elevenlabs.realtime.RealtimeModel({
      agentId: 'oYxMlLkXbNtZDS3zCikc',
      audioOptions: {
        sampleRate: 22050,
        inFrameSize: 2205,
        outFrameSize: 1102,
      },
      configOverride: {
        conversation_config_override: {
          agent: {
            language: 'es',
          },
        },
      },
      apiKey: 'ANYTHING_FOR_PUBLIC_AGENTS',
    });

    const agent = new multimodal.MultimodalAgent({
      model,
    });

    await agent
      .start(ctx.room, participant)
      .then((session) => session as elevenlabs.realtime.RealtimeSession);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
