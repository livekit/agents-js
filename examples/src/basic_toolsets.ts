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
  llm,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const getWeather = llm.tool({
      description: 'Get the weather for a given location.',
      parameters: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }) => {
        return `The weather in ${location} is sunny.`;
      },
    });

    const lookupTimezone = llm.tool({
      description: 'Look up the timezone for a city or region.',
      parameters: z.object({
        location: z.string().describe('The city or region to look up'),
      }),
      execute: async ({ location }) => {
        return `${location} is in the America/Los_Angeles timezone.`;
      },
    });

    const locationTools = new llm.Toolset({
      id: 'location_tools',
      tools: {
        getWeather,
        lookupTimezone,
      },
    });

    const agent = new voice.Agent({
      instructions:
        'You are a helpful assistant. Use the location toolset when users ask about weather or timezones.',
      tools: {
        ...locationTools.toolCtx,
      },
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    session.say('Hello, ask me about the weather or timezone for a location.');
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
