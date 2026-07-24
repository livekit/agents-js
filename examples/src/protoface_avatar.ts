// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as protoface from '@livekit/agents-plugin-protoface';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions: 'Talk to me!',
    });

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        voice: 'cedar',
      }),
      turnHandling: {
        interruption: {
          resumeFalseInterruption: false,
        },
      },
    });

    await ctx.connect();

    const avatar = new protoface.AvatarSession({
      avatarId: process.env.PROTOFACE_AVATAR_ID || protoface.DEFAULT_STOCK_AVATAR_ID,
    });
    await avatar.start(session, ctx.room);

    await session.start({
      agent,
      room: ctx.room,
      outputOptions: {
        audioEnabled: false,
        syncTranscription: false,
      },
    });

    session.generateReply({ instructions: 'Say hello to the user.' });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
