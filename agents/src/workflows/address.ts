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

export interface GetAddressResult {
  address: string;
}

export interface GetAddressTaskOptions {
  /**
   * Instructions for the address capture prompt. Pass a full string or {@link Instructions} to
   * replace the built-in prompt entirely, or {@link InstructionParts} to override individual
   * sections (e.g. `persona`) while keeping the built-in template.
   */
  instructions?: InstructionParts | Instructions | string;
  chatCtx?: ChatContext;
  turnDetection?: TurnDetectionMode;
  tools?: readonly ToolContextEntry[];
  stt?: STT | STTModelString;
  vad?: VAD;
  llm?: LLM | RealtimeModel | LLMModels;
  tts?: TTS | TTSModelString;
  allowInterruptions?: boolean;
  /**
   * Whether to ask the user to confirm the captured address. Defaults to confirming on audio
   * input and skipping confirmation on text input.
   */
  requireConfirmation?: boolean;
  /**
   * When true, the model must produce an asking utterance before recording an address — it
   * can't silently fill one from the chat context during `onEnter`.
   */
  requireExplicitAsk?: boolean;
}

interface UpdateAddressArgs {
  streetAddress: string;
  unitNumber: string;
  locality: string;
  country: string;
}

/**
 * Build an {@link AgentTask} that collects a postal address from the user.
 *
 * This is the functional core; {@link GetAddressTask} is a thin class wrapper over it.
 */
export function createGetAddressTask({
  instructions,
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
}: GetAddressTaskOptions = {}): AgentTask<GetAddressResult> {
  let currentAddress = '';

  const confirmationRequired = (ctx: RunContext): boolean => {
    if (requireConfirmation !== undefined) {
      return requireConfirmation;
    }
    return ctx.speechHandle.inputDetails.modality === 'audio';
  };

  // confirm tool is only injected after update_address is called,
  // preventing the LLM from hallucinating a confirmation without user input
  const buildConfirmTool = (address: string) =>
    tool({
      name: 'confirm_address',
      description: 'Call after the user confirms the address is correct.',
      execute: async () => {
        if (address !== currentAddress) {
          task.session.generateReply({
            instructions:
              'The address has changed since confirmation was requested, ask the user to confirm the updated address.',
          });
          return;
        }

        if (!task.done) {
          task.complete({ address });
        }
      },
    });

  const updateAddressTool = tool({
    name: 'update_address',
    description: 'Update the address provided by the user.',
    parameters: z.object({
      streetAddress: z
        .string()
        .describe(
          'Dependent on country, may include fields like house number, street name, block, or district',
        ),
      unitNumber: z
        .string()
        .describe(
          "The unit number, for example Floor 1 or Apartment 12. If there is no unit number, return ''",
        ),
      locality: z
        .string()
        .describe('Dependent on country, may include fields like city, zip code, or province'),
      country: z.string().describe('The country the user lives in spelled out fully'),
    }),
    // With requireExplicitAsk, the model can't silent-fill from chatCtx during
    // onEnter — it must produce an asking utterance first.
    flags: requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE,
    execute: async (
      { streetAddress, unitNumber, locality, country }: UpdateAddressArgs,
      { ctx },
    ) => {
      const addressFields = unitNumber.trim()
        ? [streetAddress, unitNumber, locality, country]
        : [streetAddress, locality, country];
      const address = addressFields.join(' ');
      currentAddress = address;

      if (!confirmationRequired(ctx)) {
        if (!task.done) {
          task.complete({ address: currentAddress });
        }
        return;
      }

      const confirmTool = buildConfirmTool(address);
      const currentTools = task.toolCtx.tools.filter((t) => t.id !== 'confirm_address');
      await task.updateTools([...currentTools, confirmTool]);

      return (
        `The address has been updated to ${address}\n` +
        `Repeat the address field by field: ${JSON.stringify(addressFields)} if needed\n` +
        `Prompt the user for confirmation, do not call \`confirm_address\` directly`
      );
    },
  });

  const declineTool = tool({
    name: 'decline_address_capture',
    description: 'Handles the case when the user explicitly declines to provide an address.',
    parameters: z.object({
      reason: z
        .string()
        .describe('A short explanation of why the user declined to provide the address'),
    }),
    flags: ToolFlag.IGNORE_ON_ENTER,
    execute: async ({ reason }: { reason: string }) => {
      if (!task.done) {
        task.complete(new ToolError(`couldn't get the address: ${reason}`));
      }
    },
  });

  const task = AgentTask.create<GetAddressResult>({
    id: 'get_address_task',
    instructions: resolveWorkflowInstructions({
      instructions,
      template: INSTRUCTIONS_TEMPLATE,
      defaultPersona: PERSONA,
      modalitySpecific: new Instructions('', {
        audio: AUDIO_SPECIFIC,
        text: TEXT_SPECIFIC,
      }),
      confirmation: new Instructions('', {
        // confirmation is enabled by default for audio, disabled by default for text
        audio: requireConfirmation !== false ? CONFIRMATION_INSTRUCTION : '',
        text: requireConfirmation === true ? CONFIRMATION_INSTRUCTION : '',
      }),
    }),
    chatCtx,
    turnDetection,
    tools: [...tools, updateAddressTool, declineTool],
    stt,
    vad,
    llm,
    tts,
    allowInterruptions,
    onEnter: async () => {
      task.session.generateReply({ instructions: 'Ask the user to provide their address.' });
    },
  });

  return task;
}

/**
 * Class wrapper around {@link createGetAddressTask}, preserving the
 * `new GetAddressTask(options).run()` API. It composes the functional task and
 * delegates `run()` to it.
 */
export class GetAddressTask extends AgentTask<GetAddressResult> {
  readonly #task: AgentTask<GetAddressResult>;

  constructor(options: GetAddressTaskOptions = {}) {
    // The wrapper itself never runs as an agent; run() delegates to the
    // composed task. Instructions are resolved inside createGetAddressTask.
    super({ instructions: '' });
    this.#task = createGetAddressTask(options);
  }

  override run(): Promise<GetAddressResult> {
    return this.#task.run();
  }
}

// instructions
const PERSONA =
  'You are only a single step in a broader system, responsible solely for capturing an address.';

const AUDIO_SPECIFIC = `You will be handling addresses from any country.
Expect that users will say address in different formats with fields filled like:
- 'streetAddress': '450 SOUTH MAIN ST', 'unitNumber': 'FLOOR 2', 'locality': 'SALT LAKE CITY UT 84101', 'country': 'UNITED STATES',
- 'streetAddress': '123 MAPLE STREET', 'unitNumber': 'APARTMENT 10', 'locality': 'OTTAWA ON K1A 0B1', 'country': 'CANADA',
- 'streetAddress': 'GUOMAO JIE 3 HAO, CHAOYANG QU', 'unitNumber': 'GUOMAO DA SHA 18 LOU 101 SHI', 'locality': 'BEIJING SHI 100000', 'country': 'CHINA',
- 'streetAddress': '5 RUE DE L’ANCIENNE COMÉDIE', 'unitNumber': 'APP C4', 'locality': '75006 PARIS', 'country': 'FRANCE',
- 'streetAddress': 'PLOT 10, NEHRU ROAD', 'unitNumber': 'OFFICE 403, 4TH FLOOR', 'locality': 'VILE PARLE (E), MUMBAI MAHARASHTRA 400099', 'country': 'INDIA',
Normalize common spoken patterns silently:
- Convert words like 'dash' and 'apostrophe' into symbols: \`-\`, \`'\`.
- Convert spelled out numbers like 'six' and 'seven' into numerals: \`6\`, \`7\`.
- Recognize patterns where users speak their address field followed by spelling: e.g., 'guomao g u o m a o'.
- Filter out filler words or hesitations.
- Recognize when there may be accents on certain letters if explicitly said or common in the location specified. Be sure to verify the correct accents if existent.
Don't mention corrections. Treat inputs as possibly imperfect but fix them silently.
When reading a numerical ordinal suffix (st, nd, rd, th), the number must be verbally expanded into its full, correctly pronounced word form.
Do not read the number and the suffix letters separately.
Confirm postal codes by reading them out digit-by-digit as a sequence of single numbers. Do not read them as cardinal numbers.
For example, read 90210 as 'nine zero two one zero.'
Avoid using bullet points and parenthese in any responses.
Spell out the address letter-by-letter when applicable, such as street names and provinces, especially when the user spells it out initially.`;

const TEXT_SPECIFIC = `You will be handling addresses from any country.
Expect users to type their address directly.
If the address looks almost correct but has minor issues (e.g. missing country or postal code), prompt for clarification.`;

const CONFIRMATION_INSTRUCTION = `Call \`confirm_address\` after the user confirmed the address is correct.`;

const INSTRUCTIONS_TEMPLATE = `{persona}

{modalitySpecific}

Call \`update_address\` at the first opportunity whenever you form a new hypothesis about the address. (before asking any questions or providing any answers.)
Don't invent new addresses, stick strictly to what the user said.
{confirmation}
If the address is unclear or invalid, or it takes too much back-and-forth, prompt for it in parts in this order: street address, unit number if applicable, locality, and country.

Ignore unrelated input and avoid going off-topic. Do not generate markdown, greetings, or unnecessary commentary.
Always explicitly invoke a tool when applicable. Do not simulate tool usage, no real action is taken unless the tool is explicitly called.

{extra}
`;
