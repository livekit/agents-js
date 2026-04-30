// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as liveavatar from '@livekit/agents-plugin-liveavatar';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const logger = log().child({ example: 'liveavatar_avatar' });

    const avatarId = process.env.LIVEAVATAR_AVATAR_ID || undefined;
    const videoQuality: liveavatar.VideoQuality | undefined = undefined;

    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'en',
      }),
      llm: new inference.LLM({
        model: 'openai/gpt-4.1-mini',
      }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
      voiceOptions: {
        preemptiveGeneration: true,
      },
    });

    await ctx.connect();

    await session.start({
      agent: new voice.Agent({
        instructions:
          'You are a helpful avatar assistant. Keep responses concise, friendly, and natural.',
      }),
      room: ctx.room,
      outputOptions: {
        syncTranscription: false,
      },
    });

    const avatar = new liveavatar.AvatarSession({
      avatarId,
      videoQuality,
    });
    await avatar.start(session, ctx.room);

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      logger.info({ oldState: ev.oldState, newState: ev.newState }, 'Agent state changed');
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      logger.info({ oldState: ev.oldState, newState: ev.newState }, 'User state changed');
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      logger.info(
        { final: ev.isFinal, transcript: ev.transcript, language: ev.language },
        'User transcript received',
      );
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      logger.error({ error: ev.error, source: ev.source }, 'Session emitted error');
    });

    ctx.addShutdownCallback(async () => {
      logger.info({ usage: session.usage }, 'Session usage summary');
    });

    session.generateReply({
      instructions:
        'Greet the user, tell them this is a LiveAvatar example, and ask them to interrupt you mid-sentence.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
