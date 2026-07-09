// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { LLMModels, STTModelString, TTSModelString } from '../inference/index.js';
import type { ChatContext, LLM, RealtimeModel, ToolContextEntry } from '../llm/index.js';
import { Instructions, ToolError, ToolFlag, tool } from '../llm/index.js';
import type { STT } from '../stt/index.js';
import type { TTS } from '../tts/index.js';
import type { VAD } from '../vad.js';
import { AgentTask } from '../voice/agent.js';
import type { TurnDetectionMode } from '../voice/agent_session.js';
import type { RunContext } from '../voice/run_context.js';
import { type InstructionParts, resolveWorkflowInstructions } from './utils.js';

export interface GetEmailResult {
  emailAddress: string;
}

export interface GetEmailTaskOptions {
  /**
   * Instructions for the email capture prompt. Pass a full string or {@link Instructions} to
   * replace the built-in prompt entirely, or {@link InstructionParts} to override individual
   * sections (e.g. `persona`) while keeping the built-in template.
   */
  instructions?: InstructionParts | Instructions | string;
  chatCtx?: ChatContext;
  turnDetection?: TurnDetectionMode | null;
  tools?: readonly ToolContextEntry[];
  stt?: STT | STTModelString | null;
  vad?: VAD | null;
  llm?: LLM | RealtimeModel | LLMModels | null;
  tts?: TTS | TTSModelString | null;
  allowInterruptions?: boolean;
  /**
   * Whether to ask the user to confirm the captured email address. Defaults to confirming on
   * audio input and skipping confirmation on text input.
   */
  requireConfirmation?: boolean;
  /**
   * When true, the model must produce an asking utterance before recording an email address —
   * it can't silently fill one from the chat context during `onEnter`.
   */
  requireExplicitAsk?: boolean;
  /** @deprecated use `instructions.extra` instead */
  extraInstructions?: string;
}

/**
 * Build an {@link AgentTask} that collects an email address from the user.
 *
 * This is the functional core; {@link GetEmailTask} is a thin class wrapper over it.
 */
export function createGetEmailTask({
  instructions,
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
  extraInstructions = '',
}: GetEmailTaskOptions = {}): AgentTask<GetEmailResult> {
  let currentEmail = '';

  const confirmationRequired = (ctx: RunContext): boolean => {
    if (requireConfirmation !== undefined) {
      return requireConfirmation;
    }
    return ctx.speechHandle.inputDetails.modality === 'audio';
  };

  const buildConfirmTool = (email: string) =>
    tool({
      name: 'confirm_email_address',
      description: 'Call after the user confirms the email address is correct.',
      execute: async () => {
        if (email !== currentEmail) {
          task.session.generateReply({
            instructions:
              'The email has changed since confirmation was requested, ask the user to confirm the updated email.',
          });
          return;
        }

        if (!task.done) {
          task.complete({ emailAddress: email });
        }
      },
    });

  const updateEmailTool = tool({
    name: 'update_email_address',
    description: 'Update the email address provided by the user.',
    parameters: z.object({
      email: z.string().describe('The email address provided by the user'),
    }),
    // With requireExplicitAsk, the model can't silent-fill from chatCtx during
    // onEnter — it must produce an asking utterance first.
    flags: requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE,
    execute: async ({ email }: { email: string }, { ctx }) => {
      email = email.trim();

      if (!EMAIL_REGEX.test(email)) {
        throw new ToolError(`Invalid email address provided: ${email}`);
      }

      currentEmail = email;
      const separatedEmail = email.split('').join(' ');

      if (!confirmationRequired(ctx)) {
        if (!task.done) {
          task.complete({ emailAddress: currentEmail });
        }
        return undefined; // no need to continue the conversation
      }

      const confirmTool = buildConfirmTool(email);
      const currentTools = task.toolCtx.tools.filter((t) => t.id !== 'confirm_email_address');
      await task.updateTools([...currentTools, confirmTool]);

      return (
        `The email has been updated to ${email}\n` +
        `Repeat the email character by character: ${separatedEmail} if needed\n` +
        `Prompt the user for confirmation, do not call \`confirm_email_address\` directly`
      );
    },
  });

  const declineTool = tool({
    name: 'decline_email_capture',
    description: 'Handles the case when the user explicitly declines to provide an email address.',
    parameters: z.object({
      reason: z
        .string()
        .describe('A short explanation of why the user declined to provide the email address'),
    }),
    flags: ToolFlag.IGNORE_ON_ENTER,
    execute: async ({ reason }: { reason: string }) => {
      if (!task.done) {
        task.complete(new ToolError(`couldn't get the email address: ${reason}`));
      }
    },
  });

  const task = AgentTask.create<GetEmailResult>({
    id: 'get_email_task',
    instructions: resolveWorkflowInstructions({
      instructions,
      extraInstructions,
      template: INSTRUCTIONS_TEMPLATE,
      defaultPersona: PERSONA,
      kwargs: {
        _modality_specific: new Instructions('', {
          audio: AUDIO_SPECIFIC,
          text: TEXT_SPECIFIC,
        }),
        _confirmation: new Instructions('', {
          // confirmation is enabled by default for audio, disabled by default for text
          audio: requireConfirmation !== false ? CONFIRMATION_INSTRUCTION : '',
          text: requireConfirmation === true ? CONFIRMATION_INSTRUCTION : '',
        }),
      },
    }),
    chatCtx,
    turnDetection: turnDetection ?? undefined,
    tools: [...(tools ?? []), updateEmailTool, declineTool],
    stt: stt ?? undefined,
    vad: vad ?? undefined,
    llm: llm ?? undefined,
    tts: tts ?? undefined,
    allowInterruptions,
    onEnter: async () => {
      task.session.generateReply({ instructions: 'Ask the user to provide an email address.' });
    },
  });

  return task;
}

/**
 * Class wrapper around {@link createGetEmailTask}, preserving the
 * `new GetEmailTask(options).run()` API. It composes the functional task and
 * delegates `run()` to it.
 */
export class GetEmailTask extends AgentTask<GetEmailResult> {
  readonly #task: AgentTask<GetEmailResult>;

  constructor(options: GetEmailTaskOptions = {}) {
    // The wrapper itself never runs as an agent; run() delegates to the
    // composed task. Instructions are resolved inside createGetEmailTask.
    super({ instructions: '' });
    this.#task = createGetEmailTask(options);
  }

  override run(): Promise<GetEmailResult> {
    return this.#task.run();
  }
}

const EMAIL_REGEX =
  /^[A-Za-z0-9][A-Za-z0-9._%+\-]*@(?:[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

// instructions
const PERSONA =
  'You are only a single step in a broader system, responsible solely for capturing an email address.';

const AUDIO_SPECIFIC = `Handle input as noisy voice transcription. Expect that users will say emails aloud with formats like:
- 'john dot doe at gmail dot com'
- 'susan underscore smith at yahoo dot co dot uk'
- 'dave dash b at protonmail dot com'
- 'jane at example' (partial—prompt for the domain)
- 'theo t h e o at livekit dot io' (name followed by spelling)
Normalize common spoken patterns silently:
- Convert words like 'dot', 'underscore', 'dash', 'plus' into symbols: \`.\`, \`_\`, \`-\`, \`+\`.
- Convert 'at' to \`@\`.
- Recognize patterns where users speak their name or a word, followed by spelling: e.g., 'john j o h n'.
- Filter out filler words or hesitations.
- Assume some spelling if contextually obvious (e.g. 'mike b two two' → mikeb22).
Don't mention corrections. Treat inputs as possibly imperfect but fix them silently.`;

const TEXT_SPECIFIC = `Handle input as typed text. Expect users to type their email address directly in standard format.
If the address looks almost correct but has minor typos (e.g. missing '@' or domain), prompt for clarification.`;

const CONFIRMATION_INSTRUCTION = `Call \`confirm_email_address\` after the user confirmed the email address is correct.`;

const INSTRUCTIONS_TEMPLATE = `{persona}

{_modality_specific}

Call \`update_email_address\` at the first opportunity whenever you form a new hypothesis about the email. (before asking any questions or providing any answers.)
Don't invent new email addresses, stick strictly to what the user said.
{_confirmation}
If the email is unclear or invalid, or it takes too much back-and-forth, prompt for it in parts: first the part before the '@', then the domain—only if needed.

Ignore unrelated input and avoid going off-topic. Do not generate markdown, greetings, or unnecessary commentary.
Always explicitly invoke a tool when applicable. Do not simulate tool usage, no real action is taken unless the tool is explicitly called.

{extra}
`;
