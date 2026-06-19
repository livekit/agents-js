// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { LLMModels, STTModelString, TTSModelString } from '../../inference/index.js';
import type { ChatContext, LLM, RealtimeModel, ToolContextEntry } from '../../llm/index.js';
import { Instructions, ToolError, ToolFlag, tool } from '../../llm/index.js';
import type { STT } from '../../stt/index.js';
import type { TTS } from '../../tts/index.js';
import type { VAD } from '../../vad.js';
import { AgentTask } from '../../voice/agent.js';
import type { TurnDetectionMode } from '../../voice/agent_session.js';

const BASE_INSTRUCTIONS = `
You are only a single step in a broader system, responsible solely for capturing a date of birth.
{modality_specific}
{time_instructions}Call \`update_dob\` at the first opportunity whenever you form a new hypothesis about the date of birth. (before asking any questions or providing any answers.)
Don't invent dates, stick strictly to what the user said.
{confirmation_instructions}
When reading back dates, use a natural spoken format like 'January fifteenth, nineteen ninety'.
If the date is unclear or invalid, or it takes too much back-and-forth, prompt for it in parts: first the month, then the day, then the year.
Ignore unrelated input and avoid going off-topic. Do not generate markdown, greetings, or unnecessary commentary.
Avoid verbosity by not sharing example dates or formats unless prompted to do so. Do not deviate from the goal of collecting the user's birthday.
Always explicitly invoke a tool when applicable. Do not simulate tool usage, no real action is taken unless the tool is explicitly called.{extra_instructions}
`;

const AUDIO_SPECIFIC = `
Handle input as noisy voice transcription. Expect that users will say dates aloud with formats like:
- 'January 15th 1990'
- 'the fifteenth of January nineteen ninety'
- '01 15 1990' or 'one fifteen ninety'
- 'Jan 15 90'
- '15th January 1990'
Normalize common spoken patterns silently:
- Convert spoken numbers and ordinals to their numeric form: 'fifteenth' -> 15, 'ninety' -> 1990.
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

function renderTemplate(
  template: string,
  replacements: Record<
    'modality_specific' | 'time_instructions' | 'confirmation_instructions' | 'extra_instructions',
    string
  >,
): string {
  return template.replace(
    /\{(modality_specific|time_instructions|confirmation_instructions|extra_instructions)\}/g,
    (_match, key: keyof typeof replacements) => replacements[key],
  );
}

function createDateOnly(year: number, month: number, day: number): Date {
  if (year < 1 || year > 9999) {
    throw new ToolError(`Invalid date: ${year}-${month}-${day}`);
  }

  const date = new Date(Date.UTC(0, month - 1, day));
  date.setUTCFullYear(year);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ToolError(`Invalid date: ${year}-${month}-${day}`);
  }

  return date;
}

function todayDateOnly(): Date {
  const today = new Date();
  return createDateOnly(today.getFullYear(), today.getMonth() + 1, today.getDate());
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatTime(time: TimeOfBirth): string {
  const date = new Date(Date.UTC(2000, 0, 1, time.hour, time.minute));
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  }).format(date);
}

export interface TimeOfBirth {
  hour: number;
  minute: number;
}

export interface GetDOBResult {
  dateOfBirth: Date;
  timeOfBirth: TimeOfBirth | null;
}

export interface GetDOBTaskOptions {
  extraInstructions?: string;
  includeTime?: boolean;
  chatCtx?: ChatContext;
  turnDetection?: TurnDetectionMode | null;
  tools?: readonly ToolContextEntry[];
  stt?: STT | STTModelString | null;
  vad?: VAD | null;
  llm?: LLM | RealtimeModel | LLMModels | null;
  tts?: TTS | TTSModelString | null;
  allowInterruptions?: boolean;
  requireConfirmation?: boolean;
  requireExplicitAsk?: boolean;
}

export class GetDOBTask extends AgentTask<GetDOBResult> {
  private _includeTime: boolean;
  private _requireConfirmation?: boolean;
  private _requireExplicitAsk: boolean;
  private _currentDob: Date | null = null;
  private _currentTime: TimeOfBirth | null = null;

  constructor(options: GetDOBTaskOptions = {}) {
    const {
      extraInstructions = '',
      includeTime = false,
      chatCtx,
      turnDetection,
      tools,
      stt,
      vad,
      llm,
      tts,
      allowInterruptions,
      requireConfirmation,
      requireExplicitAsk = false,
    } = options;

    const timeInstructions = includeTime
      ? "Also ask for and capture the time of birth if the user knows it. The time is optional - if the user doesn't know it, proceed without it.\n"
      : '';
    const confirmationInstructions =
      'Call `confirm_dob` after the user confirmed the date of birth is correct.';
    const renderInstructions = (modalitySpecific: string, confirmation: string) =>
      renderTemplate(BASE_INSTRUCTIONS, {
        modality_specific: modalitySpecific,
        time_instructions: timeInstructions,
        confirmation_instructions: confirmation,
        extra_instructions: extraInstructions,
      });

    super({
      instructions: new Instructions({
        audio: renderInstructions(
          AUDIO_SPECIFIC,
          requireConfirmation !== false ? confirmationInstructions : '',
        ),
        text: renderInstructions(
          TEXT_SPECIFIC,
          requireConfirmation === true ? confirmationInstructions : '',
        ),
      }),
      chatCtx,
      turnDetection: turnDetection ?? undefined,
      tools,
      stt: stt ?? undefined,
      vad: vad ?? undefined,
      llm: llm ?? undefined,
      tts: tts ?? undefined,
      allowInterruptions,
    });

    this._includeTime = includeTime;
    this._requireConfirmation = requireConfirmation;
    this._requireExplicitAsk = requireExplicitAsk;

    const taskTools = [
      ...(tools ?? []),
      this.buildUpdateDOBTool(),
      this.buildDeclineDOBCaptureTool(),
    ];
    if (includeTime) {
      taskTools.push(this.buildUpdateTimeTool());
    }
    void this.updateTools(taskTools);
  }

  async onEnter(): Promise<void> {
    await this.session.generateReply({
      instructions: this._includeTime
        ? 'Ask the user to provide their date of birth and, if they know it, their time of birth.'
        : 'Ask the user to provide their date of birth.',
    });
  }

  private buildUpdateDOBTool() {
    const flags = this._requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE;

    return tool({
      name: 'update_dob',
      description:
        "Update the date of birth provided by the user. Given a spoken month and year (e.g., 'July 2030'), return its numerical representation (7/2030).",
      flags,
      parameters: z.object({
        year: z.number().int().describe('The birth year (e.g., 1990)'),
        month: z.number().int().min(1).max(12).describe('The birth month (1-12)'),
        day: z.number().int().min(1).max(31).describe('The birth day (1-31)'),
      }),
      execute: async ({ year, month, day }: { year: number; month: number; day: number }, opts) =>
        this.updateDOB(year, month, day, opts.ctx.speechHandle.inputDetails.modality),
    });
  }

  private async updateDOB(
    year: number,
    month: number,
    day: number,
    modality: 'audio' | 'text',
  ): Promise<string | null> {
    // Match the prompt's intent for two-digit years; otherwise year 90 is valid AD 90.
    if (year >= 0 && year < 100) {
      const currentYear = new Date().getFullYear() % 100;
      year += year <= currentYear ? 2000 : 1900;
    }

    const dob = createDateOnly(year, month, day);
    if (dob > todayDateOnly()) {
      throw new ToolError(
        `Invalid date of birth: ${formatDate(dob)} is in the future. Date of birth cannot be a future date.`,
      );
    }

    this._currentDob = dob;

    if (!this.confirmationRequired(modality)) {
      if (!this.done) {
        this.complete(this.result());
      }
      return null;
    }

    const confirmTool = this.buildConfirmTool(dob);
    const currentTools = this.toolCtx.tools.filter((t) => !('id' in t) || t.id !== 'confirm_dob');
    await this.updateTools([...currentTools, confirmTool]);

    let response = `The date of birth has been updated to ${formatDate(dob)}`;
    if (this._currentTime) {
      response += ` at ${formatTime(this._currentTime)}`;
    }

    return (
      `${response}\nRepeat the date back to the user in a natural spoken format.\n` +
      'Prompt the user for confirmation, do not call `confirm_dob` directly'
    );
  }

  private buildUpdateTimeTool() {
    return tool({
      name: 'update_time',
      description: 'Update the time of birth provided by the user.',
      parameters: z.object({
        hour: z.number().int().min(0).max(23).describe('The birth hour (0-23)'),
        minute: z.number().int().min(0).max(59).describe('The birth minute (0-59)'),
      }),
      execute: async ({ hour, minute }: { hour: number; minute: number }, opts) =>
        this.updateTime(hour, minute, opts.ctx.speechHandle.inputDetails.modality),
    });
  }

  private async updateTime(
    hour: number,
    minute: number,
    modality: 'audio' | 'text',
  ): Promise<string | null> {
    this._currentTime = { hour, minute };

    if (!this.confirmationRequired(modality) && this._currentDob !== null) {
      if (!this.done) {
        this.complete(this.result());
      }
      return null;
    }

    if (this.confirmationRequired(modality)) {
      const confirmTool = this.buildConfirmTool(this._currentDob);
      const currentTools = this.toolCtx.tools.filter((t) => !('id' in t) || t.id !== 'confirm_dob');
      await this.updateTools([...currentTools, confirmTool]);
    }

    let response = `The time of birth has been updated to ${formatTime(this._currentTime)}`;
    if (this._currentDob) {
      response = `The date and time of birth has been updated to ${formatDate(this._currentDob)} at ${formatTime(this._currentTime)}`;
    }

    if (this.confirmationRequired(modality)) {
      response +=
        '\nRepeat the time back to the user in a natural spoken format.\n' +
        'Prompt the user for confirmation, do not call `confirm_dob` directly';
    } else {
      response += '\nThe date of birth has not been provided yet, ask the user to provide it.';
    }

    return response;
  }

  private buildConfirmTool(capturedDob: Date | null) {
    const capturedTime = this._currentTime;

    return tool({
      name: 'confirm_dob',
      description: 'Call after the user confirms the date of birth is correct.',
      execute: async () => {
        if (
          capturedDob?.getTime() !== this._currentDob?.getTime() ||
          capturedTime?.hour !== this._currentTime?.hour ||
          capturedTime?.minute !== this._currentTime?.minute
        ) {
          await this.session.generateReply({
            instructions:
              'The date of birth has changed since confirmation was requested, ask the user to confirm the updated date.',
          });
          return;
        }

        if (this._currentDob === null) {
          await this.session.generateReply({
            instructions: 'No date of birth was provided yet, ask the user to provide it.',
          });
          return;
        }

        if (!this.done) {
          this.complete(this.result());
        }
      },
    });
  }

  private buildDeclineDOBCaptureTool() {
    return tool({
      name: 'decline_dob_capture',
      description: 'Handles the case when the user explicitly declines to provide a date of birth.',
      flags: ToolFlag.IGNORE_ON_ENTER,
      parameters: z.object({
        reason: z
          .string()
          .describe('A short explanation of why the user declined to provide the date of birth'),
      }),
      execute: async ({ reason }: { reason: string }) => {
        if (!this.done) {
          this.complete(new ToolError(`couldn't get the date of birth: ${reason}`));
        }
      },
    });
  }

  private confirmationRequired(modality: 'audio' | 'text'): boolean {
    if (this._requireConfirmation !== undefined) {
      return this._requireConfirmation;
    }
    return modality === 'audio';
  }

  private result(): GetDOBResult {
    if (!this._currentDob) {
      throw new Error('date of birth has not been provided');
    }

    return {
      dateOfBirth: this._currentDob,
      timeOfBirth: this._currentTime,
    };
  }
}
