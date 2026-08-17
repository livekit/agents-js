// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  Agent,
  AgentTask,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  handoff,
  inference,
  llm,
  voice,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

function createInfoTask(info: string): AgentTask<string> {
  const task = AgentTask.create<string>({
    instructions: `Collect the user's information. around ${info}. Once you have the information, call the saveUserInfo tool to save the information to the database IMMEDIATELY. DO NOT have chitchat with the user, just collect the information and call the saveUserInfo tool.`,
    tts: 'elevenlabs/eleven_turbo_v2_5',
    tools: [
      llm.tool({
        name: 'saveUserInfo',
        description: `Save the user's ${info} to database`,
        parameters: z.object({
          [info]: z.string(),
        }),
        execute: async (args) => {
          task.complete(args[info] as string);
          return `Thanks, collected ${info} successfully: ${args[info]}`;
        },
      }),
    ],
    onEnter: (ctx) => {
      ctx.session.generateReply({
        userInput: `Ask the user for their ${info}`,
      });
    },
  });

  return task;
}

function createWeatherAgent() {
  return Agent.create({
    instructions:
      'You are a weather agent. You are responsible for providing the weather information to the user.',
    tts: 'deepgram/aura-2',
    tools: [
      llm.tool({
        name: 'getWeather',
        description: 'Get the weather for a given location',
        parameters: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: async ({ location }) => {
          return `The weather in ${location} is sunny today.`;
        },
      }),
      llm.tool({
        name: 'finishWeatherConversation',
        description: 'Call this when you want to finish the weather conversation',
        execute: async () => {
          return llm.handoff({
            agent: createSurveyAgent(),
            returns: 'Transfer to survey agent successfully!',
          });
        },
      }),
    ],
  });
}

function createSurveyAgent(): Agent {
  return Agent.create({
    instructions:
      'You orchestrate a short intro survey. Speak naturally and keep the interaction brief.',
    tools: [
      llm.tool({
        name: 'collectUserInfo',
        description: 'Call this when user want to provide some information to you',
        parameters: z.object({
          key: z
            .string()
            .describe(
              'The key of the information to collect, e.g. "name" or "role" should be no space and underscore separated',
            ),
        }),
        execute: async ({ key }) => {
          const value = await createInfoTask(key).run();
          return `Collected ${key} successfully: ${value}`;
        },
      }),
      llm.tool({
        name: 'transferToWeatherAgent',
        description: 'Call this immediately after user want to know the weather',
        execute: async () => {
          const agent = createWeatherAgent();
          return handoff({ agent, returns: "Let's start the weather conversation!" });
        },
      }),
    ],
    onEnter: async (ctx) => {
      const name = await createInfoTask('name').run();
      const role = await createInfoTask('role').run();

      await ctx.session.say(
        `Great to meet you ${name}. I noted your role as ${role}. We can continue now.`,
      );
    },
  });
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new openai.responses.LLM({ useWebSocket: true }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
    });

    await session.start({
      room: ctx.room,
      agent: createSurveyAgent(),
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
