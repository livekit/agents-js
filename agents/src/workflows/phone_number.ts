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

const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;

export interface GetPhoneNumberResult {
  phoneNumber: string;
}

export interface GetPhoneNumberTaskOptions {
  /** Extra instructions appended to the built-in prompt for domain-specific context. */
  extraInstructions?: string;
  chatCtx?: ChatContext;
  turnDetection?: TurnDetectionMode | null;
  tools?: readonly ToolContextEntry[];
  stt?: STT | STTModelString | null;
  vad?: VAD | null;
  llm?: LLM | RealtimeModel | LLMModels | null;
  tts?: TTS | TTSModelString | null;
  allowInterruptions?: boolean;
  /**
   * Whether to ask the user to confirm the captured phone number. Defaults to confirming on
   * audio input and skipping confirmation on text input.
   */
  requireConfirmation?: boolean;
  /**
   * When true, the model must produce an asking utterance before recording a phone number — it
   * can't silently fill one from the chat context during `onEnter`.
   */
  requireExplicitAsk?: boolean;
}

/**
 * Build an {@link AgentTask} that collects a phone number from the user.
 *
 * This is the functional core; {@link GetPhoneNumberTask} is a thin class wrapper over it.
 */
export function createGetPhoneNumberTask({
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
}: GetPhoneNumberTaskOptions = {}): AgentTask<GetPhoneNumberResult> {
  const confirmationInstructions =
    'Call `confirm_phone_number` after the user confirmed the phone number is correct.';

  let currentPhoneNumber = '';

  const confirmationRequired = (ctx: RunContext): boolean => {
    if (requireConfirmation !== undefined) {
      return requireConfirmation;
    }
    return ctx.speechHandle.inputDetails.modality === 'audio';
  };

  const buildConfirmTool = (phoneNumber: string) =>
    tool({
      name: 'confirm_phone_number',
      description: 'Call after the user confirms the phone number is correct.',
      execute: async () => {
        if (phoneNumber !== currentPhoneNumber) {
          task.session.generateReply({
            instructions:
              'The phone number has changed since confirmation was requested, ask the user to confirm the updated number.',
          });
          return;
        }

        if (!task.done) {
          task.complete({ phoneNumber });
        }
      },
    });

  const updatePhoneNumberTool = tool({
    name: 'update_phone_number',
    description: 'Update the phone number provided by the user.',
    parameters: z.object({
      phone_number: z
        .string()
        .describe('The phone number provided by the user, digits only with optional leading +'),
    }),
    // With requireExplicitAsk, the model can't silent-fill from chatCtx during
    // onEnter — it must produce an asking utterance first.
    flags: requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE,
    execute: async ({ phone_number: phoneNumber }: { phone_number: string }, { ctx }) => {
      const cleaned = phoneNumber.trim().replace(/[\s\-().]+/g, '');

      if (!PHONE_REGEX.test(cleaned)) {
        throw new ToolError(`Invalid phone number provided: ${phoneNumber}`);
      }

      currentPhoneNumber = cleaned;

      if (!confirmationRequired(ctx)) {
        if (!task.done) {
          task.complete({ phoneNumber: currentPhoneNumber });
        }
        return undefined; // no need to continue the conversation
      }

      const confirmTool = buildConfirmTool(cleaned);
      const currentTools = task.toolCtx.tools.filter((t) => t.id !== 'confirm_phone_number');
      await task.updateTools([...currentTools, confirmTool]);

      return (
        `The phone number has been updated to ${cleaned}\n` +
        `Read the number back to the user in groups.\n` +
        `Prompt the user for confirmation, do not call \`confirm_phone_number\` directly`
      );
    },
  });

  const declineTool = tool({
    name: 'decline_phone_number_capture',
    description: 'Handles the case when the user explicitly declines to provide a phone number.',
    parameters: z.object({
      reason: z
        .string()
        .describe('A short explanation of why the user declined to provide the phone number'),
    }),
    flags: ToolFlag.IGNORE_ON_ENTER,
    execute: async ({ reason }: { reason: string }) => {
      if (!task.done) {
        task.complete(new ToolError(`couldn't get the phone number: ${reason}`));
      }
    },
  });

  const task = AgentTask.create<GetPhoneNumberResult>({
    id: 'get_phone_number_task',
    instructions: new Instructions('', {
      audio: safeRender(BASE_INSTRUCTIONS, {
        modality_specific: AUDIO_SPECIFIC,
        confirmation_instructions: requireConfirmation !== false ? confirmationInstructions : '',
        extra_instructions: extraInstructions,
      }),
      text: safeRender(BASE_INSTRUCTIONS, {
        modality_specific: TEXT_SPECIFIC,
        confirmation_instructions: requireConfirmation === true ? confirmationInstructions : '',
        extra_instructions: extraInstructions,
      }),
    }),
    chatCtx,
    turnDetection: turnDetection ?? undefined,
    tools: [...(tools ?? []), updatePhoneNumberTool, declineTool],
    stt: stt ?? undefined,
    vad: vad ?? undefined,
    llm: llm ?? undefined,
    tts: tts ?? undefined,
    allowInterruptions,
    onEnter: async () => {
      task.session.generateReply({ instructions: 'Ask the user to provide their phone number.' });
    },
  });

  return task;
}

/**
 * Class wrapper around {@link createGetPhoneNumberTask}, preserving the
 * `new GetPhoneNumberTask(options).run()` API. It composes the functional task and
 * delegates `run()` to it.
 */
export class GetPhoneNumberTask extends AgentTask<GetPhoneNumberResult> {
  readonly #task: AgentTask<GetPhoneNumberResult>;

  constructor(options: GetPhoneNumberTaskOptions = {}) {
    // The wrapper itself never runs as an agent; run() delegates to the
    // composed task. Instructions are resolved inside createGetPhoneNumberTask.
    super({ instructions: '' });
    this.#task = createGetPhoneNumberTask(options);
  }

  override run(): Promise<GetPhoneNumberResult> {
    return this.#task.run();
  }
}

const BASE_INSTRUCTIONS = `
You are only a single step in a broader system, responsible solely for capturing a phone number.
{modality_specific}
Call \`update_phone_number\` at the first opportunity whenever you form a new hypothesis about the phone number. (before asking any questions or providing any answers.)
Don't invent phone numbers, stick strictly to what the user said.
{confirmation_instructions}
If the number is unclear or invalid, or it takes too much back-and-forth, prompt for it in parts: first the area code, then the remaining digits.
Never repeat the phone number back to the user as a single block of digits. Read it back in groups.
Ignore unrelated input and avoid going off-topic. Do not generate markdown, greetings, or unnecessary commentary.
Avoid verbosity by not sharing example phone numbers or formats unless prompted to do so. Do not deviate from the goal of collecting the user's phone number.
Always explicitly invoke a tool when applicable. Do not simulate tool usage, no real action is taken unless the tool is explicitly called.\
{extra_instructions}
`;

const AUDIO_SPECIFIC = `
Handle input as noisy voice transcription. Expect that users will say phone numbers aloud with formats like:
- '555 123 4567'
- 'five five five, one two three, four five six seven'
- '+1 555 123 4567'
- 'area code 555, 123 4567'
- '555-123-4567'
Normalize common spoken patterns silently:
- Convert spoken digits to their numeric form: 'five' → 5, 'zero' → 0, 'oh' → 0.
- Remove filler words, pauses, and hesitations.
- Strip dashes, spaces, parentheses, and dots from the number.
- Recognize 'plus' at the start as the international prefix \`+\`.
- Recognize 'area code' as a prefix for the area code digits.
Don't mention corrections. Treat inputs as possibly imperfect but fix them silently.
`;

const TEXT_SPECIFIC = `
Handle input as typed text. Expect users to type their phone number directly.
Strip dashes, spaces, parentheses, and dots from the number.
If the number looks almost correct but has minor formatting issues, clean it up silently.
`;
