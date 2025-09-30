// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  inference,
  metrics,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
    });

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      // stt: 'deepgram/nova-3',
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        extraKwargs: {
          filler_words: false,
        },
      }),
      // llm: 'azure/gpt-4.1',
      llm: new inference.LLM({
        model: 'azure/gpt-4.1',
        extraKwargs: {
          top_p: 0.9,
        },
      }),
      // tts: 'elevenlabs:cgSgspJ2msm6clMCkdW9',
      tts: new inference.TTS({
        model: 'elevenlabs:cgSgspJ2msm6clMCkdW9',
        extraKwargs: {
          apply_text_normalization: 'on',
        },
      }),
      // to use realtime model, replace the stt, llm, tts and vad with the following
      // llm: new openai.realtime.RealtimeModel(),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
    });

    const usageCollector = new metrics.UsageCollector();

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
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

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
