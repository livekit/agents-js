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
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

class InfoTask extends voice.AgentTask<string> {
  constructor(info: string) {
    super({
      instructions: `Collect the user's information. around ${info}. Once you have the information, call the saveUserInfo tool to save the information to the database IMMEDIATELY. DO NOT have chitchat with the user, just collect the information and call the saveUserInfo tool.`,
      tts: 'elevenlabs/eleven_turbo_v2_5',
      tools: {
        saveUserInfo: llm.tool({
          description: `Save the user's ${info} to database`,
          parameters: z.object({
            [info]: z.string(),
          }),
          execute: async (args) => {
            this.complete(args[info] as string);
            return `Thanks, collected ${info} successfully: ${args[info]}`;
          },
        }),
      },
    });
  }

  async onEnter() {
    this.session.generateReply({
      userInput: 'Ask the user for their ${info}',
    });
  }
}

class SurveyAgent extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You orchestrate a short intro survey. Speak naturally and keep the interaction brief.',
      tools: {
        collectUserInfo: llm.tool({
          description: 'Call this when user want to provide some information to you',
          parameters: z.object({
            key: z
              .string()
              .describe(
                'The key of the information to collect, e.g. "name" or "role" should be no space and underscore separated',
              ),
          }),
          execute: async ({ key }) => {
            const value = await new InfoTask(key).run();
            return `Collected ${key} successfully: ${value}`;
          },
        }),
        transferToWeatherAgent: llm.tool({
          description: 'Call this immediately after user want to know the weather',
          execute: async () => {
            const agent = new voice.Agent({
              instructions:
                'You are a weather agent. You are responsible for providing the weather information to the user.',
              tts: 'deepgram/aura-2',
              tools: {
                getWeather: llm.tool({
                  description: 'Get the weather for a given location',
                  parameters: z.object({
                    location: z.string().describe('The location to get the weather for'),
                  }),
                  execute: async ({ location }) => {
                    return `The weather in ${location} is sunny today.`;
                  },
                }),
                finishWeatherConversation: llm.tool({
                  description: 'Call this when you want to finish the weather conversation',
                  execute: async () => {
                    return llm.handoff({
                      agent: new SurveyAgent(),
                      returns: 'Transfer to survey agent successfully!',
                    });
                  },
                }),
              },
            });

            return llm.handoff({ agent, returns: "Let's start the weather conversation!" });
          },
        }),
      },
    });
  }

  async onEnter() {
    const name = await new InfoTask('name').run();
    const role = await new InfoTask('role').run();

    await this.session.say(
      `Great to meet you ${name}. I noted your role as ${role}. We can continue now.`,
    );
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new openai.responses.LLM(),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
    });

    await session.start({
      room: ctx.room,
      agent: new SurveyAgent(),
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
