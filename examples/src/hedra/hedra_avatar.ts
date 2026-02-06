// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  initializeLogger,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as hedra from '@livekit/agents-plugin-hedra';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

// import { readFileSync } from 'node:fs';
// import { dirname, join } from 'node:path';
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    initializeLogger({ pretty: true });

    const agent = new voice.Agent({
      instructions: 'You are a helpful assistant. Speak clearly and concisely.',
    });

    const logger = log();
    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'en',
      }),
      llm: new inference.LLM({
        model: 'openai/gpt-4o-mini',
      }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      vad: ctx.proc.userData.vad! as silero.VAD,
      turnDetection: new livekit.turnDetector.MultilingualModel(),
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    const avatar = new hedra.AvatarSession({
      avatarId: process.env.HEDRA_AVATAR_ID,
      // API key is read from HEDRA_API_KEY environment variable by default

      // Alternatively, use a custom avatar image:
      // const avatarImageData = readFileSync(join(__dirname, 'avatar.png'));
      // avatarImage: {
      //   data: avatarImageData,
      //   mimeType: 'image/png',
      //   filename: 'avatar.png',
      // },
    });
    await avatar.start(session, ctx.room);

    // Log metrics as they are emitted (session.usage is automatically collected)
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    // Log usage summary when job shuts down
    ctx.addShutdownCallback(async () => {
      logger.info(
        {
          usage: session.usage,
        },
        'Session usage summary',
      );
    });

    session.generateReply({
      instructions: 'Greet the user briefly and confirm you are ready.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
