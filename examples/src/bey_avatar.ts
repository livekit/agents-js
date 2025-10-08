// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  metrics,
  voice,
} from '@livekit/agents';
import * as bey from '@livekit/agents-plugin-bey';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const agent = new voice.Agent({
      instructions: 'Talk to me!',
    });

    const vad = ctx.proc.userData.vad! as silero.VAD;

    // Create agent session with realtime model
    const agentSession = new voice.AgentSession({
      vad,
      llm: new openai.realtime.RealtimeModel({ voice: 'alloy' }),
    });

    // Get avatar ID from environment variable or use default
    const avatarId = process.env.BEY_AVATAR_ID;

    // Create and start Bey avatar session
    const beyAvatarSession = new bey.AvatarSession({
      avatarId: avatarId || undefined,
    });

    await beyAvatarSession.start(agentSession, ctx.room);

    const usageCollector = new metrics.UsageCollector();

    agentSession.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    // Start the agent session
    await agentSession.start({
      agent,
      room: ctx.room,
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
