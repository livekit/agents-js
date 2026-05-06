// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, beta, createAgentServer, dedent, llm, voice } from '@livekit/agents';
import { access, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const { Agent, AgentTask } = voice;

type SurveyState = {
  candidateName: string;
};

type SubTaskProps = {
  filename: string;
  surveyState: SurveyState;
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

const createDisqualifyTool = (props: SubTaskProps) =>
  llm.tool({
    description: dedent`
      End the interview if the candidate refuses to cooperate, provides inappropriate answers, or is not a fit.
    `,
    parameters: z.object({
      disqualificationReason: z.string().describe('Why the interview should end immediately'),
    }),
    execute: async (ctx, { disqualificationReason }) => {
      const reason = `[DISQUALIFIED] ${disqualificationReason}`;
      await writeCsvRow(props.filename, {
        name: props.surveyState.candidateName || 'unknown',
        disqualificationReason: reason,
      });
      await ctx.session.say(
        `Thanks for your time today. We are ending the interview now. Reason: ${disqualificationReason}.`,
      );
      ctx.session.shutdown();
      return 'Interview ended and disqualification saved.';
    },
  });

const IntroTask = (props: SubTaskProps) =>
  AgentTask.create<{ name: string; intro: string }>({
    instructions: dedent`
      You are Alex, an interviewer screening a software engineer candidate.
      Gather the candidate name and short self-introduction.
    `,

    tools: {
      saveIntro: llm.tool({
        description: 'Save candidate name and intro notes.',
        parameters: z.object({
          name: z.string().describe('Candidate name'),
          intro: z.string().describe('Short notes from their introduction'),
        }),
        execute: async (ctx, { name, intro }) => {
          props.surveyState.candidateName = name;
          ctx.complete({ name, intro });
          return `Saved intro for ${name}.`;
        },
      }),
    },

    onEnter: async (ctx) => {
      await ctx.generateReply({
        instructions: dedent`
          Welcome the candidate and collect their name plus a brief self-introduction, then call saveIntro.
        `,
      });
    },
  });

const EmailTask = (props: SubTaskProps) =>
  AgentTask.create<{ email: string }>({
    instructions: dedent`
      Collect a valid email address.
      If the candidate refuses, call disqualify immediately.
    `,

    tools: {
      disqualify: createDisqualifyTool(props),
      saveEmail: llm.tool({
        description: 'Save candidate email address.',
        parameters: z.object({
          email: z.string().describe('Candidate email'),
        }),
        execute: async (ctx, { email }) => {
          ctx.complete({ email });
          return `Saved email: ${email}`;
        },
      }),
    },

    onEnter: async (ctx) => {
      await ctx.generateReply({
        instructions: dedent`
          Ask for the candidate email and call saveEmail as soon as you get it.
        `,
      });
    },
  });

const CommuteTask = (props: SubTaskProps) =>
  AgentTask.create<{
    canCommute: boolean;
    commuteMethod: 'driving' | 'bus' | 'subway' | 'none';
  }>({
    instructions: dedent`
      Collect commute flexibility.
      The role expects office attendance three days per week.
    `,

    tools: {
      disqualify: createDisqualifyTool(props),
      saveCommute: llm.tool({
        description: 'Save candidate commute information.',
        parameters: z.object({
          canCommute: z.boolean().describe('Whether the candidate can commute to office'),
          commuteMethod: z
            .enum(['driving', 'bus', 'subway', 'none'])
            .describe('Main commute method'),
        }),
        execute: async (ctx, { canCommute, commuteMethod }) => {
          ctx.complete({ canCommute, commuteMethod });
          return 'Saved commute flexibility.';
        },
      }),
    },

    onEnter: async (ctx) => {
      await ctx.generateReply({
        instructions: dedent`
          Ask if the candidate can commute to office regularly and capture the commute method, then call saveCommute.
        `,
      });
    },
  });

const ExperienceTask = (props: SubTaskProps) =>
  AgentTask.create<{ yearsOfExperience: number; experienceDescription: string }>({
    instructions: dedent`
      Collect years of experience and a concise timeline of previous roles relevant to software engineering.
    `,

    tools: {
      disqualify: createDisqualifyTool(props),
      saveExperience: llm.tool({
        description: 'Save candidate experience details.',
        parameters: z.object({
          yearsOfExperience: z.number().describe('Total years of professional software experience'),
          experienceDescription: z.string().describe('Summary of previous roles and employers'),
        }),
        execute: async (ctx, { yearsOfExperience, experienceDescription }) => {
          ctx.complete({ yearsOfExperience, experienceDescription });
          return 'Saved experience details.';
        },
      }),
    },

    onEnter: async (ctx) => {
      await ctx.generateReply({
        instructions: dedent`
          Ask about years of experience and previous roles, then call saveExperience once gathered.
        `,
      });
    },
  });

const BehavioralTask = (props: SubTaskProps) =>
  AgentTask.create<BehavioralResults>({
    state: (): { partial: Partial<BehavioralResults> } => ({ partial: {} }),

    instructions: dedent`
      Collect strengths, weaknesses, and work style.
      Keep a natural conversational tone and avoid bullet lists.
    `,

    tools: {
      disqualify: createDisqualifyTool(props),
      saveStrengths: llm.tool({
        description: "Save a concise summary of the candidate's strengths.",
        parameters: z.object({
          strengths: z.string().describe('Strengths summary'),
        }),
        execute: async (ctx, { strengths }) => {
          ctx.state.partial = { ...ctx.state.partial, strengths };
          checkBehavioralCompletion(ctx);
          return 'Saved strengths.';
        },
      }),
      saveWeaknesses: llm.tool({
        description: "Save a concise summary of the candidate's weaknesses.",
        parameters: z.object({
          weaknesses: z.string().describe('Weaknesses summary'),
        }),
        execute: async (ctx, { weaknesses }) => {
          ctx.state.partial = { ...ctx.state.partial, weaknesses };
          checkBehavioralCompletion(ctx);
          return 'Saved weaknesses.';
        },
      }),
      saveWorkStyle: llm.tool({
        description: "Save candidate's work style.",
        parameters: z.object({
          workStyle: z.enum(['independent', 'team_player']).describe('Primary work style'),
        }),
        execute: async (ctx, { workStyle }) => {
          ctx.state.partial = { ...ctx.state.partial, workStyle };
          checkBehavioralCompletion(ctx);
          return 'Saved work style.';
        },
      }),
    },

    onEnter: async (ctx) => {
      await ctx.generateReply({
        instructions: dedent`
          In a conversational way, gather strengths, weaknesses, and work style, then call save* tools.
        `,
      });
    },
  });

function checkBehavioralCompletion(ctx: {
  state: { partial: Partial<BehavioralResults> };
  complete: (result: BehavioralResults) => void;
  generateReply: (options: { instructions: string }) => void;
}) {
  const p = ctx.state.partial;
  if (p.strengths && p.weaknesses && p.workStyle) {
    ctx.complete({
      strengths: p.strengths,
      weaknesses: p.weaknesses,
      workStyle: p.workStyle,
    });
    return;
  }
  ctx.generateReply({
    instructions: dedent`
      Continue gathering missing behavioral details in a concise, natural dialogue and use save* tools.
    `,
  });
}

const SurveyAgent = ({ filename }: { filename: string }) => {
  const endScreening = llm.tool({
    description: 'End interview and hang up.',
    execute: async (ctx) => {
      ctx.session.shutdown();
      return 'Interview concluded.';
    },
  });

  return Agent.create({
    state: (): SurveyState => ({ candidateName: '' }),

    instructions: dedent`
      You are a survey interviewer for a software engineer screening.
      Be concise, professional, and natural.
      Call endScreening when the process is complete.
    `,

    tools: {
      endScreening,
    },

    onEnter: async (ctx) => {
      const taskProps: SubTaskProps = { filename, surveyState: ctx.state };

      const group = new beta.TaskGroup({ summarizeChatCtx: false });
      group.add(() => IntroTask(taskProps), {
        id: 'intro_task',
        description: 'Collect candidate name and intro',
      });
      group.add(() => EmailTask(taskProps), {
        id: 'email_task',
        description: 'Collect candidate email',
      });
      group.add(() => CommuteTask(taskProps), {
        id: 'commute_task',
        description: 'Collect commute flexibility and method',
      });
      group.add(() => ExperienceTask(taskProps), {
        id: 'experience_task',
        description: 'Collect years of experience and role history',
      });
      group.add(() => BehavioralTask(taskProps), {
        id: 'behavioral_task',
        description: 'Collect strengths, weaknesses, and work style',
      });

      const result = await group.run();

      const summaryItem = ctx.chatCtx.items[ctx.chatCtx.items.length - 1];
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
      await writeCsvRow(filename, mergedResults);

      await ctx.session.say(
        'The interview is now complete. Thank you for your time. We will follow up within three business days.',
      );
    },
  });
};

const app = createAgentServer();

app.rtc(async (ctx: JobContext) => {
  const session = new voice.AgentSession({
    llm: 'openai/gpt-4.1',
    stt: 'deepgram/nova-3',
    tts: 'cartesia/sonic-3',
  });

  await session.start({
    agent: SurveyAgent({ filename: 'survey_results.csv' }),
    room: ctx.room,
  });
});

// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.VITEST === undefined) {
  app.run({ path: fileURLToPath(import.meta.url) });
}

export default app;
