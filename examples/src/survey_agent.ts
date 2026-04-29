// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type Signal,
  beta,
  createAgentServer,
  createComposable,
  createSnapshotable,
  dedent,
  defineAgent,
  defineAgentTask,
  voice,
} from '@livekit/agents';
import { access, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

type SurveyAgentProps = {
  filename: string;
};

// Props are plain JSON; a trivial snapshotable is enough.
const surveyPropsSnapshotable = createSnapshotable<SurveyAgentProps>({
  snapshot: async ({ filename }) => JSON.stringify({ filename }),
  restore: async (s) => JSON.parse(s) as SurveyAgentProps,
});

// Sub-tasks share the filename and a reference to the parent agent's
// candidateName signal. Passing the signal (not its value) keeps the
// durable storage on the parent agent while letting tasks read/write it.
type SubTaskProps = {
  filename: string;
  candidateName: Signal<string>;
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

// Shared across every sub-task: registers a `disqualify` tool on the
// composing task's context. Reads candidateName from the parent's signal
// so the value survives checkpoint/restore.
const disqualifyComposable = createComposable((ctx, props: SubTaskProps) => {
  ctx.tool('disqualify', {
    description: dedent`
      End the interview if the candidate refuses to cooperate, provides inappropriate answers, or is not a fit.
    `,
    parameters: z.object({
      disqualificationReason: z.string().describe('Why the interview should end immediately'),
    }),
    execute: async ({ disqualificationReason }) => {
      const reason = `[DISQUALIFIED] ${disqualificationReason}`;
      await ctx.step(
        () =>
          writeCsvRow(props.filename, {
            name: props.candidateName.value || 'unknown',
            disqualificationReason: reason,
          }),
        'writeDisqualification',
      );
      await ctx.session.say(
        `Thanks for your time today. We are ending the interview now. Reason: ${disqualificationReason}.`,
      );
      ctx.session.shutdown();
      return 'Interview ended and disqualification saved.';
    },
  });
});

const IntroTask = defineAgentTask<IntroResults, SubTaskProps>((ctx, props) => {
  ctx.configure({
    instructions: dedent`
      You are Alex, an interviewer screening a software engineer candidate.
      Gather the candidate name and short self-introduction.
    `,
  });

  ctx.tool('saveIntro', {
    description: 'Save candidate name and intro notes.',
    parameters: z.object({
      name: z.string().describe('Candidate name'),
      intro: z.string().describe('Short notes from their introduction'),
    }),
    execute: async ({ name, intro }) => {
      // Writing the signal persists the value on the parent agent.
      props.candidateName.value = name;
      ctx.complete({ name, intro });
      return `Saved intro for ${name}.`;
    },
  });

  ctx.onEnter(async () => {
    await ctx.generateReply({
      instructions: dedent`
        Welcome the candidate and collect their name plus a brief self-introduction, then call saveIntro.
      `,
    });
  });
});

const EmailTask = defineAgentTask<EmailResults, SubTaskProps>((ctx, props) => {
  ctx.configure({
    instructions: dedent`
      Collect a valid email address.
      If the candidate refuses, call disqualify immediately.
    `,
  });

  ctx.use(disqualifyComposable(props));

  ctx.tool('saveEmail', {
    description: 'Save candidate email address.',
    parameters: z.object({
      email: z.string().describe('Candidate email'),
    }),
    execute: async ({ email }) => {
      ctx.complete({ email });
      return `Saved email: ${email}`;
    },
  });

  ctx.onEnter(async () => {
    await ctx.generateReply({
      instructions: dedent`
        Ask for the candidate email and call saveEmail as soon as you get it.
      `,
    });
  });
});

const CommuteTask = defineAgentTask<CommuteResults, SubTaskProps>((ctx, props) => {
  ctx.configure({
    instructions: dedent`
      Collect commute flexibility.
      The role expects office attendance three days per week.
    `,
  });

  ctx.use(disqualifyComposable(props));

  ctx.tool('saveCommute', {
    description: 'Save candidate commute information.',
    parameters: z.object({
      canCommute: z.boolean().describe('Whether the candidate can commute to office'),
      commuteMethod: z.enum(['driving', 'bus', 'subway', 'none']).describe('Main commute method'),
    }),
    execute: async ({ canCommute, commuteMethod }) => {
      ctx.complete({ canCommute, commuteMethod });
      return 'Saved commute flexibility.';
    },
  });

  ctx.onEnter(async () => {
    await ctx.generateReply({
      instructions: dedent`
        Ask if the candidate can commute to office regularly and capture the commute method, then call saveCommute.
      `,
    });
  });
});

const ExperienceTask = defineAgentTask<ExperienceResults, SubTaskProps>((ctx, props) => {
  ctx.configure({
    instructions: dedent`
      Collect years of experience and a concise timeline of previous roles relevant to software engineering.
    `,
  });

  ctx.use(disqualifyComposable(props));

  ctx.tool('saveExperience', {
    description: 'Save candidate experience details.',
    parameters: z.object({
      yearsOfExperience: z.number().describe('Total years of professional software experience'),
      experienceDescription: z.string().describe('Summary of previous roles and employers'),
    }),
    execute: async ({ yearsOfExperience, experienceDescription }) => {
      ctx.complete({ yearsOfExperience, experienceDescription });
      return 'Saved experience details.';
    },
  });

  ctx.onEnter(async () => {
    await ctx.generateReply({
      instructions: dedent`
        Ask about years of experience and previous roles, then call saveExperience once gathered.
      `,
    });
  });
});

const BehavioralTask = defineAgentTask<BehavioralResults, SubTaskProps>((ctx, props) => {
  ctx.configure({
    instructions: dedent`
      Collect strengths, weaknesses, and work style.
      Keep a natural conversational tone and avoid bullet lists.
    `,
  });

  ctx.use(disqualifyComposable(props));

  // Partial results survive restarts because the signal is persisted.
  const partial = ctx.signal<Partial<BehavioralResults>>(() => ({}));

  const checkCompletion = () => {
    const p = partial.value;
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
  };

  ctx.tool('saveStrengths', {
    description: "Save a concise summary of the candidate's strengths.",
    parameters: z.object({
      strengths: z.string().describe('Strengths summary'),
    }),
    execute: async ({ strengths }) => {
      partial.value = { ...partial.value, strengths };
      checkCompletion();
      return 'Saved strengths.';
    },
  });

  ctx.tool('saveWeaknesses', {
    description: "Save a concise summary of the candidate's weaknesses.",
    parameters: z.object({
      weaknesses: z.string().describe('Weaknesses summary'),
    }),
    execute: async ({ weaknesses }) => {
      partial.value = { ...partial.value, weaknesses };
      checkCompletion();
      return 'Saved weaknesses.';
    },
  });

  ctx.tool('saveWorkStyle', {
    description: "Save candidate's work style.",
    parameters: z.object({
      workStyle: z.enum(['independent', 'team_player']).describe('Primary work style'),
    }),
    execute: async ({ workStyle }) => {
      partial.value = { ...partial.value, workStyle };
      checkCompletion();
      return 'Saved work style.';
    },
  });

  ctx.onEnter(async () => {
    await ctx.generateReply({
      instructions: dedent`
        In a conversational way, gather strengths, weaknesses, and work style, then call save* tools.
      `,
    });
  });
});

const SurveyAgent = defineAgent<SurveyAgentProps>((ctx, { filename }) => {
  // Durable candidate name — lives here so it survives checkpoint/restore
  // and is visible to every sub-task via props.
  const candidateName = ctx.signal<string>(() => '');

  ctx.configure({
    instructions: dedent`
      You are a survey interviewer for a software engineer screening.
      Be concise, professional, and natural.
      Call endScreening when the process is complete.
    `,
  });

  ctx.tool('endScreening', {
    description: 'End interview and hang up.',
    execute: async () => {
      ctx.session.shutdown();
      return 'Interview concluded.';
    },
  });

  ctx.onEnter(async () => {
    const taskProps: SubTaskProps = { filename, candidateName };

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
    await ctx.step(() => writeCsvRow(filename, mergedResults), 'writeResults');

    await ctx.session.say(
      'The interview is now complete. Thank you for your time. We will follow up within three business days.',
    );
  });
}, surveyPropsSnapshotable);

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
