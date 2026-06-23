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
You are only a single step in a broader system, responsible solely for capturing the user's name.
You need to naturally collect the name parts in this order: {name_format}.
{modality_specific}
{spelling_instructions}Call \`update_name\` at the first opportunity whenever you form a new hypothesis about the name. (before asking any questions or providing any answers.)
Don't invent names, stick strictly to what the user said.
{confirmation_instructions}
If the name is unclear or it takes too much back-and-forth, prompt for each name part separately.
Ignore unrelated input and avoid going off-topic. Do not generate markdown, greetings, or unnecessary commentary.
Avoid verbosity by not sharing example names or spellings unless prompted to do so. Do not deviate from the goal of collecting the user's name.
Always explicitly invoke a tool when applicable. Do not simulate tool usage, no real action is taken unless the tool is explicitly called.{extra_instructions}
`;

const AUDIO_SPECIFIC = `
Handle input as noisy voice transcription. Expect that users will say names aloud and may:
- Say their name followed by spelling: e.g., 'Michael m i c h a e l'
- Use phonetic alphabet: e.g., 'Mike as in Mike India Charlie Hotel Alpha Echo Lima'
- Have names with special characters or hyphens: e.g., 'Mary-Jane' or 'O'Brien'
- Have names from various cultural backgrounds with different pronunciation patterns
Normalize common spoken patterns silently:
- Convert 'dash' or 'hyphen' to \`-\`.
- Convert 'apostrophe' to \`'\`.
- Recognize when users spell out their name letter by letter.
- Filter out filler words or hesitations.
- Capitalize the first letter of each name part appropriately.
Don't mention corrections. Treat inputs as possibly imperfect but fix them silently.
`;

const TEXT_SPECIFIC = `
Handle input as typed text. Expect users to type their name directly.
Capitalize the first letter of each name part appropriately.
If the name contains special characters or hyphens (e.g., 'Mary-Jane' or 'O'Brien'), preserve them as typed.
`;

function cleanNameArg(value: string | null | undefined): string | null {
  // Some models fill optional args with placeholder strings like "null" instead of omitting them.
  if (value === null || value === undefined) {
    return null;
  }

  const cleaned = value.trim().replace(/^["']+|["']+$/g, '');
  if (!cleaned) {
    return null;
  }

  if (['null', 'none', 'nil', 'n/a', 'unknown', 'unspecified'].includes(cleaned.toLowerCase())) {
    return null;
  }

  return cleaned;
}

function renderTemplate(
  template: string,
  replacements: Record<
    | 'name_format'
    | 'modality_specific'
    | 'spelling_instructions'
    | 'confirmation_instructions'
    | 'extra_instructions',
    string
  >,
): string {
  return template.replace(
    /\{(name_format|modality_specific|spelling_instructions|confirmation_instructions|extra_instructions)\}/g,
    (_match, key: keyof typeof replacements) => replacements[key],
  );
}

export interface GetNameResult {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
}

export interface GetNameTaskOptions {
  firstName?: boolean;
  lastName?: boolean;
  middleName?: boolean;
  nameFormat?: string;
  verifySpelling?: boolean;
  extraInstructions?: string;
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

export class GetNameTask extends AgentTask<GetNameResult> {
  private _collectFirstName: boolean;
  private _collectLastName: boolean;
  private _collectMiddleName: boolean;
  private _verifySpelling: boolean;
  private _requireConfirmation?: boolean;
  private _requireExplicitAsk: boolean;
  private _nameFormat: string;

  private _firstName = '';
  private _middleName = '';
  private _lastName = '';

  constructor(options: GetNameTaskOptions = {}) {
    const {
      firstName = true,
      lastName = false,
      middleName = false,
      nameFormat,
      verifySpelling = false,
      extraInstructions = '',
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

    if (!firstName && !middleName && !lastName) {
      throw new Error('At least one of firstName, middleName, or lastName must be true');
    }

    const collectedParts = [];
    if (firstName) collectedParts.push('{first_name}');
    if (middleName) collectedParts.push('{middle_name}');
    if (lastName) collectedParts.push('{last_name}');

    const resolvedNameFormat = nameFormat ?? collectedParts.join(' ');
    const spellingInstructions = verifySpelling
      ? 'After receiving the name, always verify the spelling by asking the user to confirm or spell out the name letter by letter. When confirming, spell out each name part letter by letter to the user. '
      : '';
    const confirmationInstructions =
      'Call `confirm_name` after the user confirmed the name is correct.';

    const renderInstructions = (modalitySpecific: string, confirmation: string) =>
      renderTemplate(BASE_INSTRUCTIONS, {
        name_format: resolvedNameFormat,
        modality_specific: modalitySpecific,
        spelling_instructions: spellingInstructions,
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

    this._collectFirstName = firstName;
    this._collectLastName = lastName;
    this._collectMiddleName = middleName;
    this._verifySpelling = verifySpelling;
    this._requireConfirmation = requireConfirmation;
    this._requireExplicitAsk = requireExplicitAsk;
    this._nameFormat = resolvedNameFormat;

    void this.updateTools([
      ...(tools ?? []),
      this.buildUpdateNameTool(),
      this.buildDeclineNameCaptureTool(),
    ]);
  }

  async onEnter(): Promise<void> {
    await this.session.generateReply({
      instructions:
        `Get the user's name (follow this order '${this._nameFormat}' but do not mention the format). ` +
        'First scan the conversation - if a name was already given earlier, ask a short confirmation question rather than asking from scratch. ' +
        'If context about what the name is FOR was provided (a role like "cardholder", "guest", "emergency contact"), anchor your confirmation question to that role so the user knows which name you mean - don\'t ask abstractly. ' +
        'When pointing at where an existing name came from, reference the source in the conversation (the earlier step, the booking they mentioned), not a presumption about how the name appears in the destination. ' +
        'Only ask fresh when the conversation has no name yet.',
    });
  }

  private buildUpdateNameTool() {
    const flags = this._requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE;

    return tool({
      name: 'update_name',
      description: 'Update the name provided by the user.',
      flags,
      parameters: z.object({
        first_name: z.string().nullable().optional().describe("The user's first name."),
        middle_name: z
          .string()
          .nullable()
          .optional()
          .describe("The user's middle name, if collected."),
        last_name: z.string().nullable().optional().describe("The user's last name, if collected."),
      }),
      execute: async (
        args: {
          first_name?: string | null;
          middle_name?: string | null;
          last_name?: string | null;
        },
        opts,
      ) => this.updateName(args, opts.ctx.speechHandle.inputDetails.modality),
    });
  }

  private async updateName(
    args: { first_name?: string | null; middle_name?: string | null; last_name?: string | null },
    modality: 'audio' | 'text',
  ): Promise<string | null> {
    const firstName = cleanNameArg(args.first_name);
    const middleName = cleanNameArg(args.middle_name);
    const lastName = cleanNameArg(args.last_name);
    const errors: string[] = [];

    if (this._collectFirstName && !firstName?.trim()) {
      errors.push('first name is required but was not provided');
    }
    if (this._collectMiddleName && !middleName?.trim()) {
      errors.push('middle name is required but was not provided');
    }
    if (this._collectLastName && !lastName?.trim()) {
      errors.push('last name is required but was not provided');
    }

    for (const [label, value] of [
      ['first', firstName],
      ['middle', middleName],
      ['last', lastName],
    ] as const) {
      if (value?.trim() && !Array.from(value).some((c) => /\p{L}/u.test(c))) {
        errors.push(
          `${label} name ${JSON.stringify(value)} contains no letters - that doesn't look like a name`,
        );
      }
    }

    if (errors.length > 0) {
      throw new ToolError(`Incomplete name: ${errors.join('; ')}`);
    }

    this._firstName = firstName?.trim() ?? '';
    this._middleName = middleName?.trim() ?? '';
    this._lastName = lastName?.trim() ?? '';

    const fullName = this.formatName().trim();

    if (!this.confirmationRequired(modality)) {
      if (!this.done) {
        this.complete(this.result());
      }
      return null;
    }

    const confirmTool = this.buildConfirmTool({
      firstName: this._firstName,
      middleName: this._middleName,
      lastName: this._lastName,
    });
    const currentTools = this.toolCtx.tools.filter((t) => !('id' in t) || t.id !== 'confirm_name');
    await this.updateTools([...currentTools, confirmTool]);

    if (this._verifySpelling) {
      return (
        `The name has been updated to ${fullName}\n` +
        `Spell out the name letter by letter for verification: ${fullName}\n` +
        'Prompt the user for confirmation, do not call `confirm_name` directly'
      );
    }

    return (
      `The name has been updated to ${fullName}\n` +
      'Repeat the name back to the user and prompt for confirmation, do not call `confirm_name` directly'
    );
  }

  private buildConfirmTool(expected: { firstName: string; middleName: string; lastName: string }) {
    return tool({
      name: 'confirm_name',
      description: 'Call after the user confirms the name is correct.',
      execute: async () => {
        if (
          expected.firstName !== this._firstName ||
          expected.middleName !== this._middleName ||
          expected.lastName !== this._lastName
        ) {
          await this.session.generateReply({
            instructions:
              'The name has changed since confirmation was requested, ask the user to confirm the updated name.',
          });
          return;
        }

        if (!this.done) {
          this.complete(this.result());
        }
      },
    });
  }

  private buildDeclineNameCaptureTool() {
    return tool({
      name: 'decline_name_capture',
      description: 'Handles the case when the user explicitly declines to provide their name.',
      flags: ToolFlag.IGNORE_ON_ENTER,
      parameters: z.object({
        reason: z
          .string()
          .describe('A short explanation of why the user declined to provide their name'),
      }),
      execute: async ({ reason }: { reason: string }) => {
        if (!this.done) {
          this.complete(new ToolError(`couldn't get the name: ${reason}`));
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

  private formatName(): string {
    return this._nameFormat
      .replace(/\{first_name\}/g, this._firstName)
      .replace(/\{middle_name\}/g, this._middleName)
      .replace(/\{last_name\}/g, this._lastName);
  }

  private result(): GetNameResult {
    return {
      firstName: this._collectFirstName ? this._firstName : null,
      middleName: this._collectMiddleName ? this._middleName : null,
      lastName: this._collectLastName ? this._lastName : null,
    };
  }
}
