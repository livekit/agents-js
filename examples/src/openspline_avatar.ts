// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-FileCopyrightText: 2026 OpenSpline contributors
//
// SPDX-License-Identifier: Apache-2.0
import { WorkerOptions, cli, defineAgent, voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
import * as openspline from '@livekit/agents-plugin-openspline';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();
    const session = new voice.AgentSession({
      llm: new realtime.RealtimeModel({ model: 'gpt-realtime' }),
    });
    const source = process.env.OPENSPLINE_AVATAR_ID
      ? { avatarId: process.env.OPENSPLINE_AVATAR_ID }
      : { portrait: process.env.PORTRAIT! };
    const avatar = new openspline.AvatarSession(source);
    await avatar.start(session, ctx.room);
    await session.start({
      room: ctx.room,
      agent: new voice.Agent({ instructions: 'Be helpful and concise.' }),
    });
    await session.generateReply({ instructions: 'Greet the user.' });
  },
});
cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
