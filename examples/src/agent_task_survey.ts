// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

type SurveyResult = {
  name: string;
  role: string;
};

// Ref: python examples/survey/survey_agent.py - 248-274 lines.
class IntroTask extends voice.AgentTask<SurveyResult> {
  constructor() {
    super({
      instructions:
        'Collect the user name and role. Ask concise follow-up questions if information is missing.',
      tools: {
        completeIntro: llm.tool({
          description: 'Call this after collecting the user name and role.',
          parameters: z.object({
            name: z.string().describe('User name'),
            role: z.string().describe('User role'),
          }),
          execute: async ({ name, role }) => {
            this.complete({ name, role });
            return 'Thanks, collected successfully.';
          },
        }),
      },
    });
  }

  async onEnter() {
    this.session.generateReply();
  }
}

class SurveyAgent extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You orchestrate a short intro survey. Speak naturally and keep the interaction brief.',
    });
  }

  async onEnter() {
    // Ref: python examples/survey/survey_agent.py - 284-327 lines.
    const result = await new IntroTask().run(this.session);
    await this.session.say(
      `Great to meet you ${result.name}. I noted your role as ${result.role}. We can continue now.`,
      { addToChatCtx: true },
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
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
    });

    await session.start({
      room: ctx.room,
      agent: new SurveyAgent(),
    });

    await ctx.waitForParticipant();
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
