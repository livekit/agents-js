// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// cue-cli e2e harness agent for expressive mode (expr marker dialect).
// Registered with explicit dispatch as `expressive-agent-js`.
import {
  Agent,
  AgentSession,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  tool,
  voice,
} from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = Agent.create({
      instructions:
        'You are a cheerful, expressive assistant. Keep replies to one or two short ' +
        'sentences. You can hear the user and respond with speech.',
      tools: [
        tool({
          name: 'getWeather',
          description: 'Get the weather for a given location.',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => `The weather in ${location} is sunny.`,
        }),
      ],
    });

    const session = new AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      // Inworld: free-form expression labels (with spaces) — exercises both the
      // expr dialect lowering and the transcript pacing fix.
      tts: new inference.TTS({ model: 'inworld/inworld-tts-2' }),
      expressive: voice.presets.CASUAL,
    });

    await session.start({ agent, room: ctx.room });
    session.say('Hi there! How can I help you today?');
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'expressive-agent-js',
  }),
);
