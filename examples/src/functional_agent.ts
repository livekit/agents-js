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
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { createAgentTemplate } from '@livekit/agents/functional';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Standalone tool -- reusable across agents
const getWeather = llm.tool({
  description: 'Get the weather for a given location.',
  parameters: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async ({ location }) => {
    return `The weather in ${location} is sunny.`;
  },
});

type MyAgentProps = {
  vad: silero.VAD;
};

const MyAgent = createAgentTemplate<MyAgentProps>((ctx, _props) => {
  ctx.configure({
    instructions: "You are a helpful assistant, you can hear the user's message and respond to it.",
  });

  // Register a pre-built tool
  ctx.tool('getWeather', getWeather);

  // Register an inline tool without parameters
  ctx.tool('getTime', {
    description: 'Get the current time.',
    execute: async () => {
      return `The current time is ${new Date().toLocaleTimeString()}.`;
    },
  });

  // Register an inline tool with parameters — types are fully inferred
  ctx.tool('lookupCity', {
    description: 'Look up information about a city.',
    parameters: z.object({
      city: z.string().describe('The city name'),
      includePopulation: z.boolean().optional().describe('Whether to include population data'),
    }),
    execute: async ({ city, includePopulation }) => {
      const info = `${city} is a great place to visit.`;
      return includePopulation ? `${info} Population: 1,000,000.` : info;
    },
  });

  ctx.onEnter(async () => {
    ctx.session.generateReply({
      userInput: 'Greet the user',
    });
  });

  ctx.onUserTurnCompleted(async (_chatCtx, newMessage) => {
    const logger = log();
    logger.info({ message: newMessage }, 'User turn completed');
  });
});

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext<{ vad: silero.VAD }>) => {
    const agent = MyAgent({ vad: ctx.proc.userData.vad });

    const logger = log();

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'en',
      }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnHandling: {
        turnDetection: new livekit.turnDetector.MultilingualModel(),
      },
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    ctx.addShutdownCallback(async () => {
      logger.info({ usage: session.usage }, 'Session usage summary');
    });

    await session.start({
      agent,
      room: ctx.room,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
