// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  beta,
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

const taskTts = 'elevenlabs/eleven_turbo_v2_5';

class CollectNameTask extends voice.AgentTask<string> {
  constructor() {
    super({
      instructions:
        'Collect the user name from the latest user message. As soon as you have it, call save_name.',
      tts: taskTts,
      tools: {
        save_name: llm.tool({
          description: 'Save the user name.',
          parameters: z.object({
            name: z.string().describe('The user name'),
          }),
          execute: async ({ name }) => {
            this.complete(name);
            return `Saved name: ${name}`;
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      userInput:
        'Ask the user for their name in one short sentence. Once they answer, call saveName immediately.',
    });
  }
}

class CollectEmailTask extends voice.AgentTask<string> {
  constructor() {
    super({
      instructions:
        'Collect the user email from the latest user message. As soon as you have it, call save_email.',
      tts: taskTts,
      tools: {
        save_email: llm.tool({
          description: 'Save the user email.',
          parameters: z.object({
            email: z.string().describe('The user email'),
          }),
          execute: async ({ email }) => {
            this.complete(email);
            return `Saved email: ${email}`;
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      userInput:
        'Ask the user for their email in one short sentence. Once they answer, call saveEmail immediately.',
    });
  }
}

class TaskGroupDemoAgent extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You are onboarding assistant. When user asks to begin onboarding, call startOnboarding exactly once.',
      tools: {
        startOnboarding: llm.tool({
          description: 'Start a two-step onboarding flow (name then email).',
          parameters: z.object({}),
          execute: async () => {
            const tg = new beta.TaskGroup({
              summarizeChatCtx: true,
              onTaskCompleted: async ({ taskId }) => {
                await this.session.say(`Completed task with id ${taskId}`);
              },
            });

            tg.add(() => new CollectNameTask(), {
              id: 'name_task',
              description: 'Collect user name',
            });
            tg.add(() => new CollectEmailTask(), {
              id: 'email_task',
              description: 'Collect user email',
            });

            const result = await tg.run();
            return JSON.stringify(result.taskResults);
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.say(
      'Hi! I can run a TaskGroup onboarding demo. Say "start onboarding". ' +
        'You can later say "change my name to ..." to trigger regression.',
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
      llm: new openai.responses.LLM({
        model: 'gpt-5.2',
      }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
    });

    await session.start({
      room: ctx.room,
      agent: new TaskGroupDemoAgent(),
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
