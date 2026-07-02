// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, ServerOptions, cli, defineAgent, metrics, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as trugen from '@livekit/agents-plugin-trugen';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions: 'You are a helpful assistant. Speak clearly and concisely.',
    });

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        voice: 'alloy',
      }),
    });

    await ctx.connect();

    await session.start({
      agent,
      room: ctx.room,
    });

    const avatar = new trugen.AvatarSession({
      avatarId: process.env.TRUGEN_AVATAR_ID || undefined,
    });

    await avatar.start(session, ctx.room);

    const usageCollector = new metrics.UsageCollector();

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev: voice.MetricsCollectedEvent) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    session.generateReply({
      instructions: 'Greet the user briefly in English and confirm you are ready.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
