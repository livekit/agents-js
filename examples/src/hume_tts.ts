// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  cli,
  defineAgent,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as hume from '@livekit/agents-plugin-hume';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it in 1-2 short sentences.",
    });

    const logger = log();

    const tts = new hume.TTS({
      voice: { name: 'Male English Actor', provider: hume.HumeVoiceProvider.Hume },
      modelVersion: '1',
      instantMode: true,
    });

    const session = new voice.AgentSession({
      stt: 'deepgram/nova-3',
      llm: 'openai/gpt-4.1-mini',
      tts,
      vad: ctx.proc.userData.vad! as silero.VAD,
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      voiceOptions: {
        preemptiveGeneration: true,
      },
    });

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

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp();
