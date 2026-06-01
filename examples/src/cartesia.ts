// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { llm as llmModule } from '@livekit/agents';
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
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as google from '@livekit/agents-plugin-google';
import * as openai from '@livekit/agents-plugin-openai';
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

    const logger = log();
    const vad =
      ctx.proc.userData.vad instanceof silero.VAD ? ctx.proc.userData.vad : await silero.VAD.load();

    const apiKey = process.env.CARTESIA_API_KEY;

    const llmFactories: Array<() => llmModule.LLM> = [
      () => new inference.LLM({ model: 'google/gemini-3-flash' }),
      () => new google.LLM({ model: 'gemini-3.5-flash' }),
      () => new openai.LLM({ model: 'gpt-5.4-mini' }),
    ];

    let llm: llmModule.LLM | null = null;
    for (const factory of llmFactories) {
      try {
        llm = factory();
        break;
      } catch {
        continue;
      }
    }

    if (!apiKey || llm === null) {
      const parts: string[] = [];
      if (!apiKey) {
        parts.push('CARTESIA_API_KEY is required');
      }
      if (llm === null) {
        parts.push(
          'No LLM keys were provided (e.g. LIVEKIT_INFERENCE_API_KEY + LIVEKIT_INFERENCE_API_SECRET,' +
            ' GOOGLE_API_KEY, or OPENAI_API_KEY)',
        );
      }
      throw new Error(parts.join('. '));
    }

    const session = new voice.AgentSession({
      vad,
      stt: new cartesia.STT({ model: 'ink-2', apiKey }),
      llm,
      tts: new cartesia.TTS({ model: 'sonic-3.5', apiKey }),
      turnHandling: {
        turnDetection: 'stt',
      },
    });

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

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
