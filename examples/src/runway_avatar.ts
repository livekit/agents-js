// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as runway from '@livekit/agents-plugin-runway';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const logger = log();
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      llm: new google.beta.realtime.RealtimeModel({
        thinkingConfig: { includeThoughts: false },
      }),
    });

    await ctx.connect();

    await session.start({
      agent: new voice.Agent({ instructions: 'Talk to me!' }),
      room: ctx.room,
      outputOptions: { syncTranscription: false },
    });

    const avatarId = process.env.RUNWAY_AVATAR_ID || undefined;
    const presetId = process.env.RUNWAY_AVATAR_PRESET_ID || 'cat-character';
    const avatar = new runway.AvatarSession({
      avatarId,
      presetId: avatarId ? undefined : presetId,
    });
    await avatar.start(session, ctx.room);

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    ctx.addShutdownCallback(async () => {
      logger.info({ usage: session.usage }, 'Session usage summary');
    });

    session.generateReply({ instructions: 'Say hello to the user.' });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
