// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as did from '@livekit/agents-plugin-did';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions: 'Talk to me!',
    });

    const logger = log();
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

    const agentId = process.env.DID_AGENT_ID;
    if (!agentId) {
      throw new Error('DID_AGENT_ID must be set');
    }

    const avatar = new did.AvatarSession({ agentId });
    await avatar.start(session, ctx.room);

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    ctx.addShutdownCallback(async () => {
      logger.info(
        {
          usage: session.usage,
        },
        'Session usage summary',
      );
    });

    session.generateReply({
      instructions: 'Say hello to the user.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
