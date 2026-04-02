// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  beta,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
// import * as phonic from '@livekit/agents-plugin-phonic';
import { access, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

type SurveyUserData = {
  filename: string;
  candidateName: string;
  taskResults: Record<string, unknown>;
};

type IntroResults = {
  name: string;
  intro: string;
};

type EmailResults = {
  email: string;
};

type CommuteResults = {
  canCommute: boolean;
  commuteMethod: 'driving' | 'bus' | 'subway' | 'none';
};

type ExperienceResults = {
  yearsOfExperience: number;
  experienceDescription: string;
};

type BehavioralResults = {
  strengths: string;
  weaknesses: string;
  workStyle: 'independent' | 'team_player';
};

function toCsvValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

async function writeCsvRow(path: string, data: Record<string, unknown>): Promise<void> {
  let hasFile = true;
  try {
    await access(path);
  } catch {
    hasFile = false;
  }

  const keys = Object.keys(data);
  const row = keys.map((key) => toCsvValue(data[key])).join(',') + '\n';

  if (!hasFile) {
    await appendFile(path, keys.join(',') + '\n', 'utf8');
  }
  await appendFile(path, row, 'utf8');
}

function disqualifyTool() {
  return llm.tool({
    description:
      'End the interview if the candidate refuses to cooperate, provides inappropriate answers, or is not a fit.',
    parameters: z.object({
      disqualificationReason: z.string().describe('Why the interview should end immediately'),
    }),
    execute: async ({ disqualificationReason }, { ctx }: llm.ToolOptions<SurveyUserData>) => {
      const reason = `[DISQUALIFIED] ${disqualificationReason}`;
      await writeCsvRow(ctx.userData.filename, {
        name: ctx.userData.candidateName || 'unknown',
        disqualificationReason: reason,
      });
      await ctx.session.say(
        `Thanks for your time today. We are ending the interview now. Reason: ${disqualificationReason}.`,
      );
      ctx.session.shutdown();
      return 'Interview ended and disqualification saved.';
    },
  });
}

class IntroTask extends voice.AgentTask<IntroResults> {
  constructor() {
    super({
      instructions:
        'You are Alex, an interviewer screening a software engineer candidate. Gather the candidate name and short self-introduction.',
      tools: {
        saveIntro: llm.tool({
          description: 'Save candidate name and intro notes.',
          parameters: z.object({
            name: z.string().describe('Candidate name'),
            intro: z.string().describe('Short notes from their introduction'),
          }),
          execute: async ({ name, intro }) => {
            (this.session.userData as SurveyUserData).candidateName = name;
            this.complete({ name, intro });
            return `Saved intro for ${name}.`;
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions:
        'Welcome the candidate and collect their name plus a brief self-introduction, then call saveIntro.',
    });
  }
}

class EmailTask extends voice.AgentTask<EmailResults> {
  constructor() {
    const disqualify = disqualifyTool();
    super({
      instructions:
        'Collect a valid email address. If the candidate refuses, call disqualify immediately.',
      tools: {
        disqualify,
        saveEmail: llm.tool({
          description: 'Save candidate email address.',
          parameters: z.object({
            email: z.string().describe('Candidate email'),
          }),
          execute: async ({ email }) => {
            this.complete({ email });
            return `Saved email: ${email}`;
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions: 'Ask for the candidate email and call saveEmail as soon as you get it.',
    });
  }
}

class CommuteTask extends voice.AgentTask<CommuteResults> {
  constructor() {
    const disqualify = disqualifyTool();
    super({
      instructions:
        'Collect commute flexibility. The role expects office attendance three days per week.',
      tools: {
        disqualify,
        saveCommute: llm.tool({
          description: 'Save candidate commute information.',
          parameters: z.object({
            canCommute: z.boolean().describe('Whether the candidate can commute to office'),
            commuteMethod: z
              .enum(['driving', 'bus', 'subway', 'none'])
              .describe('Main commute method'),
          }),
          execute: async ({ canCommute, commuteMethod }) => {
            this.complete({ canCommute, commuteMethod });
            return 'Saved commute flexibility.';
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions:
        'Ask if the candidate can commute to office regularly and capture the commute method, then call saveCommute.',
    });
  }
}

class ExperienceTask extends voice.AgentTask<ExperienceResults> {
  constructor() {
    const disqualify = disqualifyTool();
    super({
      instructions:
        'Collect years of experience and a concise timeline of previous roles relevant to software engineering.',
      tools: {
        disqualify,
        saveExperience: llm.tool({
          description: 'Save candidate experience details.',
          parameters: z.object({
            yearsOfExperience: z
              .number()
              .describe('Total years of professional software experience'),
            experienceDescription: z.string().describe('Summary of previous roles and employers'),
          }),
          execute: async ({ yearsOfExperience, experienceDescription }) => {
            this.complete({ yearsOfExperience, experienceDescription });
            return 'Saved experience details.';
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions:
        'Ask about years of experience and previous roles, then call saveExperience once gathered.',
    });
  }
}

class BehavioralTask extends voice.AgentTask<BehavioralResults> {
  private partial: Partial<BehavioralResults> = {};

  constructor() {
    const disqualify = disqualifyTool();
    super({
      instructions:
        'Collect strengths, weaknesses, and work style. Keep a natural conversational tone and avoid bullet lists.',
      tools: {
        disqualify,
        saveStrengths: llm.tool({
          description: "Save a concise summary of the candidate's strengths.",
          parameters: z.object({
            strengths: z.string().describe('Strengths summary'),
          }),
          execute: async ({ strengths }) => {
            this.partial.strengths = strengths;
            this.checkCompletion();
            return 'Saved strengths.';
          },
        }),
        saveWeaknesses: llm.tool({
          description: "Save a concise summary of the candidate's weaknesses.",
          parameters: z.object({
            weaknesses: z.string().describe('Weaknesses summary'),
          }),
          execute: async ({ weaknesses }) => {
            this.partial.weaknesses = weaknesses;
            this.checkCompletion();
            return 'Saved weaknesses.';
          },
        }),
        saveWorkStyle: llm.tool({
          description: "Save candidate's work style.",
          parameters: z.object({
            workStyle: z.enum(['independent', 'team_player']).describe('Primary work style'),
          }),
          execute: async ({ workStyle }) => {
            this.partial.workStyle = workStyle;
            this.checkCompletion();
            return 'Saved work style.';
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions:
        'In a conversational way, gather strengths, weaknesses, and work style, then call save* tools.',
    });
  }

  private checkCompletion() {
    if (this.partial.strengths && this.partial.weaknesses && this.partial.workStyle) {
      this.complete({
        strengths: this.partial.strengths,
        weaknesses: this.partial.weaknesses,
        workStyle: this.partial.workStyle,
      });
      return;
    }

    this.session.generateReply({
      instructions:
        'Continue gathering missing behavioral details in a concise, natural dialogue and use save* tools.',
    });
  }
}

class SurveyAgent extends voice.Agent<SurveyUserData> {
  constructor() {
    super({
      instructions:
        'You are a survey interviewer for a software engineer screening. Be concise, professional, and natural. Call endScreening when the process is complete.',
      tools: {
        endScreening: llm.tool({
          description: 'End interview and hang up.',
          execute: async (_, { ctx }: llm.ToolOptions<SurveyUserData>) => {
            ctx.session.shutdown();
            return 'Interview concluded.';
          },
        }),
      },
    });
  }

  async onEnter() {
    const group = new beta.TaskGroup({
      summarizeChatCtx: false,
    });

    group.add(() => new IntroTask(), {
      id: 'intro_task',
      description: 'Collect candidate name and intro',
    });
    group.add(() => new EmailTask(), {
      id: 'email_task',
      description: 'Collect candidate email',
    });
    group.add(() => new CommuteTask(), {
      id: 'commute_task',
      description: 'Collect commute flexibility and method',
    });
    group.add(() => new ExperienceTask(), {
      id: 'experience_task',
      description: 'Collect years of experience and role history',
    });
    group.add(() => new BehavioralTask(), {
      id: 'behavioral_task',
      description: 'Collect strengths, weaknesses, and work style',
    });

    const result = await group.run();
    const summaryItem = this.chatCtx.items[this.chatCtx.items.length - 1];
    let summaryText = '';
    if (summaryItem && 'content' in summaryItem) {
      summaryText =
        typeof summaryItem.content === 'string'
          ? summaryItem.content
          : JSON.stringify(summaryItem.content ?? '');
    }

    const mergedResults: Record<string, unknown> = {
      ...result.taskResults,
      summary: summaryText,
    };
    this.session.userData.taskResults = mergedResults;
    await writeCsvRow(this.session.userData.filename, mergedResults);

    await this.session.say(
      'The interview is now complete. Thank you for your time. We will follow up within three business days.',
    );
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession<SurveyUserData>({
      llm: 'openai/gpt-4.1',
      stt: 'deepgram/nova-3',
      tts: 'cartesia/sonic-3',
      userData: {
        filename: 'survey_results.csv',
        candidateName: '',
        taskResults: {},
      },
    });

    await session.start({
      agent: new SurveyAgent(),
      room: ctx.room,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
