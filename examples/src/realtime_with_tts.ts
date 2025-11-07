// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  log,
  voice,
} from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const logger = log();

    const getWeather = llm.tool({
      description: 'Called when the user asks about the weather.',
      parameters: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => {
        logger.info(`getting weather for ${location}`);
        return `The weather in ${location} is sunny, and the temperature is 20 degrees Celsius.`;
      },
    });

    const agent = new voice.Agent({
      instructions: 'You are a weather agent.',
      tools: {
        getWeather,
      },
    });

    const session = new voice.AgentSession({
      // Use RealtimeModel with text-only modality + separate TTS
      llm: new openai.realtime.RealtimeModel({
        modalities: ['text'], // Audio-in, text-out
      }),
      tts: new elevenlabs.TTS(),
      voiceOptions: {
        maxToolSteps: 5,
      },
    });

    await session.start({
      agent,
      room: ctx.room,
      outputOptions: {
        transcriptionEnabled: true,
        audioEnabled: true, // You can also disable audio output to use text modality only
      },
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      logger.debug('metrics_collected', ev);
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
