// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as xai from '@livekit/agents-plugin-xai';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log('waiting for participant');
    await ctx.waitForParticipant();

    const agent = new voice.Agent({
      instructions: 'You are a helpful assistant. Keep your responses short and concise.',
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

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
