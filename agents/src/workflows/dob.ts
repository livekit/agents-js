// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { LLMModels, STTModelString, TTSModelString } from '../inference/index.js';
import type { ChatContext, LLM, RealtimeModel, ToolContextEntry } from '../llm/index.js';
import { Instructions, ToolError, ToolFlag, tool } from '../llm/index.js';
import type { STT } from '../stt/index.js';
import type { TTS } from '../tts/index.js';
import { safeRender } from '../utils.js';
import type { VAD } from '../vad.js';
import { AgentTask } from '../voice/agent.js';
import type { TurnDetectionMode } from '../voice/agent_session.js';
import type { RunContext } from '../voice/run_context.js';

/** A calendar date without a timezone. `month` and `day` are 1-based. */
export interface DateOfBirth {
  year: number;
  month: number;
  day: number;
}

/** A time of day. `hour` is 0-23 and `minute` is 0-59. */
export interface TimeOfBirth {
  hour: number;
  minute: number;
}

export interface GetDOBResult {
  dateOfBirth: DateOfBirth;
  timeOfBirth?: TimeOfBirth;
}

export interface GetDOBTaskOptions {
  /** Extra instructions appended to the built-in prompt for domain-specific context. */
  extraInstructions?: string;
  /** Also capture the (optional) time of birth. Defaults to false. */
  includeTime?: boolean;
  chatCtx?: ChatContext;
  turnDetection?: TurnDetectionMode;
  tools?: readonly ToolContextEntry[];
  stt?: STT | STTModelString;
  vad?: VAD;
  llm?: LLM | RealtimeModel | LLMModels;
  tts?: TTS | TTSModelString;
  allowInterruptions?: boolean;
  /**
   * Whether to ask the user to confirm the captured date of birth. Defaults to confirming on
   * audio input and skipping confirmation on text input.
   */
  requireConfirmation?: boolean;
  /**
   * When true, the model must produce an asking utterance before recording a date of birth —
   * it can't silently fill one from the chat context during `onEnter`.
   */
  requireExplicitAsk?: boolean;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function formatDate(dob: DateOfBirth): string {
  return `${MONTH_NAMES[dob.month - 1]} ${String(dob.day).padStart(2, '0')}, ${dob.year}`;
}

function formatTime(time: TimeOfBirth): string {
  const hour12 = time.hour % 12 === 0 ? 12 : time.hour % 12;
  const period = time.hour < 12 ? 'AM' : 'PM';
  return `${String(hour12).padStart(2, '0')}:${String(time.minute).padStart(2, '0')} ${period}`;
}

function isSameDate(a: DateOfBirth | undefined, b: DateOfBirth | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function isSameTime(a: TimeOfBirth | undefined, b: TimeOfBirth | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.hour === b.hour && a.minute === b.minute;
}

/**
 * Build an {@link AgentTask} that collects a date of birth (and optionally a time of birth)
 * from the user.
 *
 * This is the functional core; {@link GetDOBTask} is a thin class wrapper over it.
 */
export function createGetDOBTask({
  extraInstructions = '',
  includeTime = false,
  chatCtx,
  turnDetection,
  tools = [],
  stt,
  vad,
  llm,
  tts,
  allowInterruptions,
  requireConfirmation,
  requireExplicitAsk = false,
}: GetDOBTaskOptions = {}): AgentTask<GetDOBResult> {
  const timeInstructions = !includeTime
    ? ''
    : 'Also ask for and capture the time of birth if the user knows it. ' +
      "The time is optional - if the user doesn't know it, proceed without it.\n";
  const confirmationInstructions =
    'Call `confirm_dob` after the user confirmed the date of birth is correct.';

  let currentDob: DateOfBirth | undefined;
  let currentTime: TimeOfBirth | undefined;

  const confirmationRequired = (ctx: RunContext): boolean => {
    if (requireConfirmation !== undefined) {
      return requireConfirmation;
    }
    return ctx.speechHandle.inputDetails.modality === 'audio';
  };

  const buildResult = (dateOfBirth: DateOfBirth): GetDOBResult => ({
    dateOfBirth,
    timeOfBirth: currentTime,
  });

  // confirm tool is only injected after update_dob/update_time is called,
  // preventing the LLM from hallucinating a confirmation without user input
  const buildConfirmTool = (capturedDob: DateOfBirth | undefined) => {
    const capturedTime = currentTime;

    return tool({
      name: 'confirm_dob',
      description: 'Call after the user confirms the date of birth is correct.',
      execute: async () => {
        if (!isSameDate(capturedDob, currentDob) || !isSameTime(capturedTime, currentTime)) {
          task.session.generateReply({
            instructions:
              'The date of birth has changed since confirmation was requested, ask the user to confirm the updated date.',
          });
          return;
        }

        if (currentDob === undefined) {
          task.session.generateReply({
            instructions: 'No date of birth was provided yet, ask the user to provide it.',
          });
          return;
        }

        if (!task.done) {
          task.complete(buildResult(currentDob));
        }
      },
    });
  };

  const injectConfirmTool = async (): Promise<void> => {
    const confirmTool = buildConfirmTool(currentDob);
    const currentTools = task.toolCtx.tools.filter((t) => t.id !== 'confirm_dob');
    await task.updateTools([...currentTools, confirmTool]);
  };

  const updateDobTool = tool({
    name: 'update_dob',
    description:
      "Update the date of birth provided by the user. Given a spoken month and year (e.g., 'July 2030'), return its numerical representation (7/2030).",
    parameters: z.object({
      year: z.number().int().describe('The birth year (e.g., 1990)'),
      month: z.number().int().describe('The birth month (1-12)'),
      day: z.number().int().describe('The birth day (1-31)'),
    }),
    // With requireExplicitAsk, the model can't silent-fill from chatCtx during
    // onEnter — it must produce an asking utterance first.
    flags: requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE,
    execute: async (
      { year, month, day }: { year: number; month: number; day: number },
      { ctx },
    ) => {
      // Normalize two-digit years to the intended century, matching what the
      // prompt already asks the model to do ("90" -> 1990, "05" -> 2005). A
      // literal two-digit year is otherwise a valid date (e.g. 90 -> year 90 AD)
      // that passes the future-date check and silently corrupts the result.
      if (year >= 0 && year < 100) {
        const currentYY = new Date().getFullYear() % 100;
        year += year <= currentYY ? 2000 : 1900;
      }

      if (month < 1 || month > 12 || day < 1 || day > 31) {
        throw new ToolError(`Invalid date: year=${year} month=${month} day=${day}`);
      }
      const candidate = new Date(Date.UTC(year, month - 1, day));
      if (
        candidate.getUTCFullYear() !== year ||
        candidate.getUTCMonth() !== month - 1 ||
        candidate.getUTCDate() !== day
      ) {
        throw new ToolError(`Invalid date: year=${year} month=${month} day=${day}`);
      }

      const dob: DateOfBirth = { year, month, day };
      const today = new Date();
      const todayParts: DateOfBirth = {
        year: today.getFullYear(),
        month: today.getMonth() + 1,
        day: today.getDate(),
      };
      const isFuture =
        dob.year > todayParts.year ||
        (dob.year === todayParts.year &&
          (dob.month > todayParts.month ||
            (dob.month === todayParts.month && dob.day > todayParts.day)));
      if (isFuture) {
        throw new ToolError(
          `Invalid date of birth: ${formatDate(dob)} is in the future. ` +
            'Date of birth cannot be a future date.',
        );
      }

      currentDob = dob;

      if (!confirmationRequired(ctx)) {
        if (!task.done) {
          task.complete(buildResult(currentDob));
        }
        return;
      }

      await injectConfirmTool();

      let response = `The date of birth has been updated to ${formatDate(dob)}`;

      if (currentTime) {
        response += ` at ${formatTime(currentTime)}`;
      }

      response +=
        '\nRepeat the date back to the user in a natural spoken format.\n' +
        'Prompt the user for confirmation, do not call `confirm_dob` directly';

      return response;
    },
  });

  const updateTimeTool = tool({
    name: 'update_time',
    description: 'Update the time of birth provided by the user.',
    parameters: z.object({
      hour: z.number().int().describe('The birth hour (0-23)'),
      minute: z.number().int().describe('The birth minute (0-59)'),
    }),
    execute: async ({ hour, minute }: { hour: number; minute: number }, { ctx }) => {
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw new ToolError(`Invalid time: hour=${hour} minute=${minute}`);
      }

      const birthTime: TimeOfBirth = { hour, minute };
      currentTime = birthTime;

      if (!confirmationRequired(ctx) && currentDob !== undefined) {
        if (!task.done) {
          task.complete(buildResult(currentDob));
        }
        return;
      }

      if (confirmationRequired(ctx)) {
        await injectConfirmTool();
      }

      let response = `The time of birth has been updated to ${formatTime(birthTime)}`;

      if (currentDob) {
        response = `The date and time of birth has been updated to ${formatDate(currentDob)} at ${formatTime(birthTime)}`;
      }

      if (confirmationRequired(ctx)) {
        response +=
          '\nRepeat the time back to the user in a natural spoken format.\n' +
          'Prompt the user for confirmation, do not call `confirm_dob` directly';
      } else {
        response += '\nThe date of birth has not been provided yet, ask the user to provide it.';
      }

      return response;
    },
  });

  const declineTool = tool({
    name: 'decline_dob_capture',
    description: 'Handles the case when the user explicitly declines to provide a date of birth.',
    parameters: z.object({
      reason: z
        .string()
        .describe('A short explanation of why the user declined to provide the date of birth'),
    }),
    flags: ToolFlag.IGNORE_ON_ENTER,
    execute: async ({ reason }: { reason: string }) => {
      if (!task.done) {
        task.complete(new ToolError(`couldn't get the date of birth: ${reason}`));
      }
    },
  });

  const task = AgentTask.create<GetDOBResult>({
    id: 'get_dob_task',
    instructions: new Instructions('', {
      audio: safeRender(BASE_INSTRUCTIONS, {
        modalitySpecific: AUDIO_SPECIFIC,
        timeInstructions,
        confirmationInstructions: requireConfirmation !== false ? confirmationInstructions : '',
        extraInstructions,
      }),
      text: safeRender(BASE_INSTRUCTIONS, {
        modalitySpecific: TEXT_SPECIFIC,
        timeInstructions,
        confirmationInstructions: requireConfirmation === true ? confirmationInstructions : '',
        extraInstructions,
      }),
    }),
    chatCtx,
    turnDetection,
    tools: [...tools, updateDobTool, declineTool, ...(includeTime ? [updateTimeTool] : [])],
    stt,
    vad,
    llm,
    tts,
    allowInterruptions,
    onEnter: async () => {
      const prompt = includeTime
        ? 'Ask the user to provide their date of birth and, if they know it, their time of birth.'
        : 'Ask the user to provide their date of birth.';
      task.session.generateReply({ instructions: prompt });
    },
  });

  return task;
}

/**
 * Class wrapper around {@link createGetDOBTask}, preserving the
 * `new GetDOBTask(options).run()` API. It composes the functional task and
 * delegates `run()` to it.
 */
export class GetDOBTask extends AgentTask<GetDOBResult> {
  readonly #task: AgentTask<GetDOBResult>;

  constructor(options: GetDOBTaskOptions = {}) {
    // The wrapper itself never runs as an agent; run() delegates to the
    // composed task. Instructions are resolved inside createGetDOBTask.
    super({ instructions: '' });
    this.#task = createGetDOBTask(options);
  }

  override run(): Promise<GetDOBResult> {
    return this.#task.run();
  }
}

const BASE_INSTRUCTIONS = `
You are only a single step in a broader system, responsible solely for capturing a date of birth.
{modalitySpecific}
{timeInstructions}Call \`update_dob\` at the first opportunity whenever you form a new hypothesis about the date of birth. (before asking any questions or providing any answers.)
Don't invent dates, stick strictly to what the user said.
{confirmationInstructions}
When reading back dates, use a natural spoken format like 'January fifteenth, nineteen ninety'.
If the date is unclear or invalid, or it takes too much back-and-forth, prompt for it in parts: first the month, then the day, then the year.
Ignore unrelated input and avoid going off-topic. Do not generate markdown, greetings, or unnecessary commentary.
Avoid verbosity by not sharing example dates or formats unless prompted to do so. Do not deviate from the goal of collecting the user's birthday.
Always explicitly invoke a tool when applicable. Do not simulate tool usage, no real action is taken unless the tool is explicitly called.\
{extraInstructions}
`;

const AUDIO_SPECIFIC = `
Handle input as noisy voice transcription. Expect that users will say dates aloud with formats like:
- 'January 15th 1990'
- 'the fifteenth of January nineteen ninety'
- '01 15 1990' or 'one fifteen ninety'
- 'Jan 15 90'
- '15th January 1990'
Normalize common spoken patterns silently:
- Convert spoken numbers and ordinals to their numeric form: 'fifteenth' → 15, 'ninety' → 1990.
- Recognize month names in various forms: 'Jan', 'January', etc.
- Handle two-digit years appropriately: '90' likely means 1990, '05' likely means 2005.
- Filter out filler words or hesitations.
Don't mention corrections. Treat inputs as possibly imperfect but fix them silently.
`;

const TEXT_SPECIFIC = `
Handle input as typed text. Expect users to type their date of birth directly.
Accept common date formats like 'MM/DD/YYYY', 'January 15, 1990', or '1990-01-15'.
Handle two-digit years appropriately: '90' likely means 1990, '05' likely means 2005.
`;
