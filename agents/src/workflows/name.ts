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

export interface GetNameResult {
  firstName?: string;
  middleName?: string;
  lastName?: string;
}

export interface GetNameTaskOptions {
  /** Collect the user's first name. Defaults to true. */
  firstName?: boolean;
  /** Collect the user's last name. Defaults to false. */
  lastName?: boolean;
  /** Collect the user's middle name. Defaults to false. */
  middleName?: boolean;
  /**
   * Order in which to collect the name parts, using `{firstName}`, `{middleName}` and
   * `{lastName}` placeholders. Defaults to the enabled parts in first/middle/last order.
   */
  nameFormat?: string;
  /** Ask the user to verify the spelling of the captured name. Defaults to false. */
  verifySpelling?: boolean;
  /** Extra instructions appended to the built-in prompt for domain-specific context. */
  extraInstructions?: string;
  chatCtx?: ChatContext;
  turnDetection?: TurnDetectionMode;
  tools?: readonly ToolContextEntry[];
  stt?: STT | STTModelString;
  vad?: VAD;
  llm?: LLM | RealtimeModel | LLMModels;
  tts?: TTS | TTSModelString;
  allowInterruptions?: boolean;
  /**
   * Whether to ask the user to confirm the captured name. Defaults to confirming on audio
   * input and skipping confirmation on text input.
   */
  requireConfirmation?: boolean;
  /**
   * When true, the model must produce an asking utterance before recording a name — it can't
   * silently fill one from the chat context during `onEnter`.
   */
  requireExplicitAsk?: boolean;
}

interface UpdateNameArgs {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
}

function cleanNameArg(value: string | null | undefined): string | undefined {
  // Some models (e.g. gemma) fill optional args with placeholder strings like
  // "null"/"NULL" instead of omitting them, or wrap values in literal quotes.
  // Normalize those to undefined/clean values so they hit the required-field
  // validation below instead of being recorded as the user's name.
  if (value == null) {
    return undefined;
  }
  const cleaned = value
    .trim()
    .replace(/^['"]+/, '')
    .replace(/['"]+$/, '');
  if (
    !cleaned ||
    ['null', 'none', 'nil', 'n/a', 'unknown', 'unspecified'].includes(cleaned.toLowerCase())
  ) {
    return undefined;
  }
  return cleaned;
}

function renderNameFormat(
  nameFormat: string,
  parts: { firstName: string; middleName: string; lastName: string },
): string {
  const replacements: Record<string, string> = {
    firstName: parts.firstName,
    middleName: parts.middleName,
    lastName: parts.lastName,
  };
  return nameFormat
    .replace(/\{(firstName|middleName|lastName)\}/g, (_match, key: string) => {
      return replacements[key] ?? '';
    })
    .trim();
}

/**
 * Build an {@link AgentTask} that collects the user's name.
 *
 * This is the functional core; {@link GetNameTask} is a thin class wrapper over it.
 */
export function createGetNameTask({
  firstName = true,
  lastName = false,
  middleName = false,
  nameFormat,
  verifySpelling = false,
  extraInstructions = '',
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
}: GetNameTaskOptions = {}): AgentTask<GetNameResult> {
  if (!(firstName || middleName || lastName)) {
    throw new Error('At least one of firstName, middleName, or lastName must be true');
  }

  let resolvedNameFormat: string;
  if (nameFormat !== undefined) {
    resolvedNameFormat = nameFormat;
  } else {
    const parts: string[] = [];
    if (firstName) parts.push('{firstName}');
    if (middleName) parts.push('{middleName}');
    if (lastName) parts.push('{lastName}');
    resolvedNameFormat = parts.join(' ');
  }

  const spellingInstructions = !verifySpelling
    ? ''
    : 'After receiving the name, always verify the spelling by asking the user to confirm ' +
      'or spell out the name letter by letter. ' +
      'When confirming, spell out each name part letter by letter to the user. ';
  const confirmationInstructions =
    'Call `confirm_name` after the user confirmed the name is correct.';

  let currentFirstName = '';
  let currentMiddleName = '';
  let currentLastName = '';

  const confirmationRequired = (ctx: RunContext): boolean => {
    if (requireConfirmation !== undefined) {
      return requireConfirmation;
    }
    return ctx.speechHandle.inputDetails.modality === 'audio';
  };

  const buildResult = (): GetNameResult => ({
    firstName: firstName ? currentFirstName : undefined,
    middleName: middleName ? currentMiddleName : undefined,
    lastName: lastName ? currentLastName : undefined,
  });

  const buildConfirmTool = (captured: { first: string; middle: string; last: string }) =>
    tool({
      name: 'confirm_name',
      description: 'Call after the user confirms the name is correct.',
      execute: async () => {
        if (
          captured.first !== currentFirstName ||
          captured.middle !== currentMiddleName ||
          captured.last !== currentLastName
        ) {
          task.session.generateReply({
            instructions:
              'The name has changed since confirmation was requested, ask the user to confirm the updated name.',
          });
          return;
        }

        if (!task.done) {
          task.complete(buildResult());
        }
      },
    });

  const updateNameTool = tool({
    name: 'update_name',
    description: 'Update the name provided by the user.',
    parameters: z.object({
      firstName: z.string().nullable().optional().describe("The user's first name."),
      middleName: z
        .string()
        .nullable()
        .optional()
        .describe("The user's middle name, if collected."),
      lastName: z.string().nullable().optional().describe("The user's last name, if collected."),
    }),
    // With requireExplicitAsk, the model can't silent-fill from chatCtx during
    // onEnter — it must produce an asking utterance first.
    flags: requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE,
    execute: async (args: UpdateNameArgs, { ctx }) => {
      const cleanedFirst = cleanNameArg(args.firstName);
      const cleanedMiddle = cleanNameArg(args.middleName);
      const cleanedLast = cleanNameArg(args.lastName);

      const errors: string[] = [];
      if (firstName && !cleanedFirst?.trim()) {
        errors.push('first name is required but was not provided');
      }
      if (middleName && !cleanedMiddle?.trim()) {
        errors.push('middle name is required but was not provided');
      }
      if (lastName && !cleanedLast?.trim()) {
        errors.push('last name is required but was not provided');
      }

      // A real name contains letters. Reject digit-only or punctuation-only
      // values so a card number, ZIP code, phone number, etc. accidentally
      // crammed into update_name fails fast instead of being recorded as
      // the user's name.
      for (const [label, value] of [
        ['first', cleanedFirst],
        ['middle', cleanedMiddle],
        ['last', cleanedLast],
      ] as const) {
        if (value && value.trim() && !/\p{L}/u.test(value)) {
          errors.push(
            `${label} name '${value}' contains no letters - that doesn't look like a name`,
          );
        }
      }

      if (errors.length > 0) {
        throw new ToolError(`Incomplete name: ${errors.join('; ')}`);
      }

      currentFirstName = cleanedFirst?.trim() ?? '';
      currentMiddleName = cleanedMiddle?.trim() ?? '';
      currentLastName = cleanedLast?.trim() ?? '';

      const fullName = renderNameFormat(resolvedNameFormat, {
        firstName: currentFirstName,
        middleName: currentMiddleName,
        lastName: currentLastName,
      });

      if (!confirmationRequired(ctx)) {
        if (!task.done) {
          task.complete(buildResult());
        }
        return;
      }

      const confirmTool = buildConfirmTool({
        first: currentFirstName,
        middle: currentMiddleName,
        last: currentLastName,
      });
      const currentTools = task.toolCtx.tools.filter((t) => t.id !== 'confirm_name');
      await task.updateTools([...currentTools, confirmTool]);

      if (verifySpelling) {
        return (
          `The name has been updated to ${fullName}\n` +
          `Spell out the name letter by letter for verification: ${fullName}\n` +
          `Prompt the user for confirmation, do not call \`confirm_name\` directly`
        );
      }

      return (
        `The name has been updated to ${fullName}\n` +
        `Repeat the name back to the user and prompt for confirmation, ` +
        `do not call \`confirm_name\` directly`
      );
    },
  });

  const declineTool = tool({
    name: 'decline_name_capture',
    description: 'Handles the case when the user explicitly declines to provide their name.',
    parameters: z.object({
      reason: z
        .string()
        .describe('A short explanation of why the user declined to provide their name'),
    }),
    flags: ToolFlag.IGNORE_ON_ENTER,
    execute: async ({ reason }: { reason: string }) => {
      if (!task.done) {
        task.complete(new ToolError(`couldn't get the name: ${reason}`));
      }
    },
  });

  const task = AgentTask.create<GetNameResult>({
    id: 'get_name_task',
    instructions: new Instructions('', {
      audio: safeRender(BASE_INSTRUCTIONS, {
        nameFormat: resolvedNameFormat,
        modalitySpecific: AUDIO_SPECIFIC,
        spellingInstructions,
        confirmationInstructions: requireConfirmation !== false ? confirmationInstructions : '',
        extraInstructions,
      }),
      text: safeRender(BASE_INSTRUCTIONS, {
        nameFormat: resolvedNameFormat,
        modalitySpecific: TEXT_SPECIFIC,
        spellingInstructions,
        confirmationInstructions: requireConfirmation === true ? confirmationInstructions : '',
        extraInstructions,
      }),
    }),
    chatCtx,
    turnDetection,
    tools: [...tools, updateNameTool, declineTool],
    stt,
    vad,
    llm,
    tts,
    allowInterruptions,
    onEnter: async () => {
      task.session.generateReply({
        instructions:
          `Get the user's name (follow this order '${resolvedNameFormat}' but do not ` +
          'mention the format). First scan the conversation - if a name was already ' +
          'given earlier, ask a short confirmation question rather than asking from ' +
          'scratch. If context about what the name is FOR was provided (a role like ' +
          "'cardholder', 'guest', 'emergency contact'), anchor your confirmation " +
          "question to that role so the user knows which name you mean - don't ask " +
          'abstractly. When pointing at where an existing name came from, reference ' +
          'the source in the conversation (the earlier step, the booking they ' +
          'mentioned), not a presumption about how the name appears in the ' +
          'destination. Only ask fresh when the conversation has no name yet.',
      });
    },
  });

  return task;
}

/**
 * Class wrapper around {@link createGetNameTask}, preserving the
 * `new GetNameTask(options).run()` API. It composes the functional task and
 * delegates `run()` to it.
 */
export class GetNameTask extends AgentTask<GetNameResult> {
  readonly #task: AgentTask<GetNameResult>;

  constructor(options: GetNameTaskOptions = {}) {
    // The wrapper itself never runs as an agent; run() delegates to the
    // composed task. Instructions are resolved inside createGetNameTask.
    super({ instructions: '' });
    this.#task = createGetNameTask(options);
  }

  override run(): Promise<GetNameResult> {
    return this.#task.run();
  }
}

const BASE_INSTRUCTIONS = `
You are only a single step in a broader system, responsible solely for capturing the user's name.
You need to naturally collect the name parts in this order: {nameFormat}.
{modalitySpecific}
{spellingInstructions}Call \`update_name\` at the first opportunity whenever you form a new hypothesis about the name. (before asking any questions or providing any answers.)
Don't invent names, stick strictly to what the user said.
{confirmationInstructions}
If the name is unclear or it takes too much back-and-forth, prompt for each name part separately.
Ignore unrelated input and avoid going off-topic. Do not generate markdown, greetings, or unnecessary commentary.
Avoid verbosity by not sharing example names or spellings unless prompted to do so. Do not deviate from the goal of collecting the user's name.
Always explicitly invoke a tool when applicable. Do not simulate tool usage, no real action is taken unless the tool is explicitly called.\
{extraInstructions}
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
