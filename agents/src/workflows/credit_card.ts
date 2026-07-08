// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { LLMModels, STTModelString, TTSModelString } from '../inference/index.js';
import type { ChatContext, LLM, RealtimeModel, ToolContextEntry } from '../llm/index.js';
import { Instructions, ToolError, ToolFlag, tool } from '../llm/index.js';
import { isToolError } from '../llm/tool_context.js';
import type { STT } from '../stt/index.js';
import type { TTS } from '../tts/index.js';
import { safeRender } from '../utils.js';
import type { VAD } from '../vad.js';
import { AgentTask } from '../voice/agent.js';
import type { TurnDetectionMode } from '../voice/agent_session.js';
import type { RunContext } from '../voice/run_context.js';
import { type GetNameResult, createGetNameTask } from './name.js';
import { TaskGroup } from './task_group.js';

const CARD_ISSUERS_LOOKUP: Record<string, string> = {
  '3': 'American Express',
  '4': 'Visa',
  '5': 'Mastercard',
  '6': 'Discover',
};

export interface GetCreditCardResult {
  cardholderName: string;
  issuer: string;
  cardNumber: string;
  securityCode: string;
  expirationDate: string;
}

interface GetCardNumberResult {
  issuer: string;
  cardNumber: string;
}

interface GetSecurityCodeResult {
  securityCode: string;
}

interface GetExpirationDateResult {
  date: string;
}

export class CardCaptureDeclinedError extends ToolError {
  readonly reason: string;

  constructor(reason: string) {
    super(`couldn't get the card details: ${reason}`);
    this.reason = reason;
  }
}

export class CardCollectionRestartError extends ToolError {
  readonly reason: string;

  constructor(reason: string) {
    super(`starting over: ${reason}`);
    this.reason = reason;
  }
}

const declineCardCaptureTool = tool({
  name: 'decline_card_capture',
  description:
    'Handles the case when the user explicitly declines to provide a detail for their card information.',
  parameters: z.object({
    reason: z
      .string()
      .describe('A short explanation of why the user declined to provide card information'),
  }),
  flags: ToolFlag.IGNORE_ON_ENTER,
  execute: async ({ reason }: { reason: string }, { ctx }) => {
    const task = ctx.session.currentAgent;
    if (task instanceof AgentTask && !task.done) {
      task.complete(new CardCaptureDeclinedError(reason));
    }
  },
});

const restartCardCollectionTool = tool({
  name: 'restart_card_collection',
  description:
    'Handles the case when the user wishes to start over the card information collection process and validate a new card.',
  parameters: z.object({
    reason: z.string().describe('A short explanation of why the user wishes to start over'),
  }),
  flags: ToolFlag.IGNORE_ON_ENTER,
  execute: async ({ reason }: { reason: string }, { ctx }) => {
    const task = ctx.session.currentAgent;
    if (task instanceof AgentTask && !task.done) {
      task.complete(new CardCollectionRestartError(reason));
    }
  },
});

/** Validates a card number via the Luhn algorithm. */
function validateCardNumber(cardNumber: string): boolean {
  if (!cardNumber || !/^\d+$/.test(cardNumber)) {
    return false;
  }
  let totalSum = 0;

  const reversedNumber = [...cardNumber].reverse();
  for (let index = 0; index < reversedNumber.length; index++) {
    const digit = Number(reversedNumber[index]);
    if (index % 2 === 1) {
      const doubledDigit = digit * 2;
      totalSum += doubledDigit > 9 ? doubledDigit - 9 : doubledDigit;
    } else {
      totalSum += digit;
    }
  }

  return totalSum % 10 === 0;
}

interface SubTaskOptions {
  chatCtx?: ChatContext;
  requireConfirmation?: boolean;
  requireExplicitAsk?: boolean;
  extraInstructions?: string;
}

function buildSubTaskInstructions(
  baseInstructions: string,
  audioSpecific: string,
  textSpecific: string,
  confirmationInstructions: string,
  requireConfirmation: boolean | undefined,
  extraInstructions: string,
): Instructions {
  const extraSuffix = extraInstructions ? `\n${extraInstructions}` : '';
  return new Instructions('', {
    audio:
      safeRender(baseInstructions, {
        modality_specific: audioSpecific,
        confirmation_instructions: requireConfirmation !== false ? confirmationInstructions : '',
      }) + extraSuffix,
    text:
      safeRender(baseInstructions, {
        modality_specific: textSpecific,
        confirmation_instructions: requireConfirmation === true ? confirmationInstructions : '',
      }) + extraSuffix,
  });
}

function createGetCardNumberTask({
  chatCtx,
  requireConfirmation,
  requireExplicitAsk = false,
  extraInstructions = '',
}: SubTaskOptions = {}): AgentTask<GetCardNumberResult> {
  let currentCardNumber = '';

  const confirmationRequired = (ctx: RunContext): boolean => {
    if (requireConfirmation !== undefined) {
      return requireConfirmation;
    }
    return ctx.speechHandle.inputDetails.modality === 'audio';
  };

  const buildConfirmTool = (cardNumber: string) =>
    tool({
      name: 'confirm_card_number',
      description: 'Call after the user repeats their card number for confirmation.',
      parameters: z.object({
        repeated_card_number: z
          .string()
          .describe('The card number repeated by the user as a string'),
      }),
      execute: async ({ repeated_card_number: repeatedCardNumber }) => {
        repeatedCardNumber = repeatedCardNumber.replace(/\D/g, '');
        if (repeatedCardNumber !== cardNumber) {
          task.session.generateReply({
            instructions: 'The repeated card number does not match, ask the user to try again.',
          });
          return;
        }

        if (!validateCardNumber(cardNumber)) {
          task.session.generateReply({
            instructions:
              'The card number is not valid, ask the user if they made a mistake or to provide another card.',
          });
        } else {
          const issuer = CARD_ISSUERS_LOOKUP[cardNumber[0]!] ?? 'Other';
          if (!task.done) {
            task.complete({ issuer, cardNumber });
          }
        }
      },
    });

  const updateCardNumberTool = tool({
    name: 'update_card_number',
    description:
      "Call to record the user's card number. Only call once the entire number has been given, do not call in increments.",
    parameters: z.object({
      card_number: z
        .string()
        .describe('The credit card number as a string with no dashes or spaces'),
    }),
    // With requireExplicitAsk, the model can't silent-fill from chatCtx during
    // onEnter — it must produce an asking utterance first.
    flags: requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE,
    execute: async ({ card_number: rawCardNumber }: { card_number: string }, { ctx }) => {
      const cardNumber = rawCardNumber.replace(/\D/g, '');
      if (cardNumber.length < 13 || cardNumber.length > 19) {
        task.session.generateReply({
          instructions:
            'The length of the card number is invalid, ask the user to repeat their card number.',
        });
        return undefined;
      }

      currentCardNumber = cardNumber;

      if (!confirmationRequired(ctx)) {
        if (!validateCardNumber(currentCardNumber)) {
          task.session.generateReply({
            instructions:
              'The card number is not valid, ask the user if they made a mistake or to provide another card.',
          });
        } else {
          const issuer = CARD_ISSUERS_LOOKUP[currentCardNumber[0]!] ?? 'Other';
          if (!task.done) {
            task.complete({ issuer, cardNumber: currentCardNumber });
          }
        }
        return undefined;
      }

      const confirmTool = buildConfirmTool(cardNumber);
      const currentTools = task.toolCtx.tools.filter((t) => t.id !== 'confirm_card_number');
      await task.updateTools([...currentTools, confirmTool]);

      return (
        'The card number has been updated.\n' +
        'Ask them to repeat the number, do not repeat the number back to them.\n'
      );
    },
  });

  const task = AgentTask.create<GetCardNumberResult>({
    id: 'get_card_number_task',
    instructions: buildSubTaskInstructions(
      CARD_NUMBER_BASE_INSTRUCTIONS,
      CARD_NUMBER_AUDIO_SPECIFIC,
      CARD_NUMBER_TEXT_SPECIFIC,
      'Call `confirm_card_number` once the user has repeated their card number.',
      requireConfirmation,
      extraInstructions,
    ),
    chatCtx,
    tools: [updateCardNumberTool, declineCardCaptureTool, restartCardCollectionTool],
    onEnter: async () => {
      await task.session.generateReply({
        instructions:
          "Get the user's credit card number. First scan the conversation - if a " +
          'credit card number was already given (e.g. the user volunteered it ' +
          'before the task started), use it via update_card_number rather than ' +
          're-asking. Only ask fresh when no credit card number is in the ' +
          'conversation yet.',
      });
    },
  });

  return task;
}

function createGetSecurityCodeTask({
  chatCtx,
  requireConfirmation,
  requireExplicitAsk = false,
  extraInstructions = '',
}: SubTaskOptions = {}): AgentTask<GetSecurityCodeResult> {
  let currentSecurityCode = '';

  const confirmationRequired = (ctx: RunContext): boolean => {
    if (requireConfirmation !== undefined) {
      return requireConfirmation;
    }
    return ctx.speechHandle.inputDetails.modality === 'audio';
  };

  const buildConfirmTool = (securityCode: string) =>
    tool({
      name: 'confirm_security_code',
      description: 'Call after the user repeats their security code for confirmation.',
      parameters: z.object({
        repeated_security_code: z.string().describe('The security code repeated by the user'),
      }),
      execute: async ({ repeated_security_code: repeatedSecurityCode }) => {
        if (repeatedSecurityCode.trim() !== securityCode) {
          task.session.generateReply({
            instructions: 'The repeated security code does not match, ask the user to try again.',
          });
          return;
        }

        if (!task.done) {
          task.complete({ securityCode });
        }
      },
    });

  const updateSecurityCodeTool = tool({
    name: 'update_security_code',
    description: "Call to update the card's security code.",
    parameters: z.object({
      security_code: z
        .string()
        .describe("The card's security code (3-4 digits, may have leading zeros)."),
    }),
    // With requireExplicitAsk, the model can't silent-fill from chatCtx during
    // onEnter — it must produce an asking utterance first.
    flags: requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE,
    execute: async ({ security_code: securityCode }: { security_code: string }, { ctx }) => {
      const stripped = securityCode.trim();
      if (!/^\d+$/.test(stripped) || stripped.length < 3 || stripped.length > 4) {
        task.session.generateReply({
          instructions:
            "The security code's length is invalid, ask the user to repeat or to provide a new card and start over.",
        });
        return undefined;
      }

      currentSecurityCode = stripped;

      if (!confirmationRequired(ctx)) {
        if (!task.done) {
          task.complete({ securityCode: currentSecurityCode });
        }
        return undefined;
      }

      const confirmTool = buildConfirmTool(stripped);
      const currentTools = task.toolCtx.tools.filter((t) => t.id !== 'confirm_security_code');
      await task.updateTools([...currentTools, confirmTool]);

      return (
        'The security code has been updated.\n' +
        'Do not repeat the security code back to the user, ask them to repeat themselves.\n' +
        'Call `confirm_security_code` once the user confirms, do not call it preemptively.\n'
      );
    },
  });

  const task = AgentTask.create<GetSecurityCodeResult>({
    id: 'get_security_code_task',
    instructions: buildSubTaskInstructions(
      SECURITY_CODE_BASE_INSTRUCTIONS,
      SECURITY_CODE_AUDIO_SPECIFIC,
      SECURITY_CODE_TEXT_SPECIFIC,
      'Call `confirm_security_code` once the user has repeated their security code.',
      requireConfirmation,
      extraInstructions,
    ),
    chatCtx,
    tools: [updateSecurityCodeTool, declineCardCaptureTool, restartCardCollectionTool],
    onEnter: async () => {
      await task.session.generateReply({
        instructions:
          "Get the user's card security code. First scan the conversation - if a " +
          'code was already given, use it via update_security_code rather than ' +
          're-asking. Only ask fresh when no code is in the conversation yet.',
      });
    },
  });

  return task;
}

function createGetExpirationDateTask({
  chatCtx,
  requireConfirmation,
  requireExplicitAsk = false,
  extraInstructions = '',
}: SubTaskOptions = {}): AgentTask<GetExpirationDateResult> {
  let currentExpirationDate = '';

  const confirmationRequired = (ctx: RunContext): boolean => {
    if (requireConfirmation !== undefined) {
      return requireConfirmation;
    }
    return ctx.speechHandle.inputDetails.modality === 'audio';
  };

  const isExpired = (month: number, year: number): boolean => {
    const today = new Date();
    const fullYear = 2000 + year;
    return (
      fullYear < today.getFullYear() ||
      (fullYear === today.getFullYear() && month < today.getMonth() + 1)
    );
  };

  const buildConfirmTool = (expirationMonth: number, expirationYear: number) => {
    const expirationDate = currentExpirationDate;

    return tool({
      name: 'confirm_expiration_date',
      description: 'Call after the user repeats their expiration date for confirmation.',
      parameters: z.object({
        repeated_expiration_month: z
          .number()
          .int()
          .describe('The expiration month repeated by the user'),
        repeated_expiration_year: z
          .number()
          .int()
          .describe('The expiration year repeated by the user'),
      }),
      execute: async ({ repeated_expiration_month, repeated_expiration_year }) => {
        if (
          repeated_expiration_month !== expirationMonth ||
          repeated_expiration_year !== expirationYear
        ) {
          task.session.generateReply({
            instructions: 'The repeated expiration date does not match, ask the user to try again.',
          });
          return;
        }

        if (!task.done) {
          task.complete({ date: expirationDate });
        }
      },
    });
  };

  const updateExpirationDateTool = tool({
    name: 'update_expiration_date',
    description:
      "Call to update the card's expiration date. Collect both the numerical month and year.",
    parameters: z.object({
      expiration_month: z
        .number()
        .int()
        .describe("The numerical expiration month of the card, example: '04' for April"),
      expiration_year: z
        .number()
        .int()
        .describe(
          "The numerical expiration year of the card shortened to the last two digits, for example, '35' for 2035",
        ),
    }),
    // With requireExplicitAsk, the model can't silent-fill from chatCtx during
    // onEnter — it must produce an asking utterance first.
    flags: requireExplicitAsk ? ToolFlag.IGNORE_ON_ENTER : ToolFlag.NONE,
    execute: async (
      {
        expiration_month: expirationMonth,
        expiration_year: expirationYear,
      }: { expiration_month: number; expiration_year: number },
      { ctx },
    ) => {
      if (expirationMonth < 1 || expirationMonth > 12) {
        task.session.generateReply({
          instructions:
            'The expiration month is invalid, ask the user to repeat the expiration month.',
        });
        return undefined;
      }
      if (expirationYear < 0 || expirationYear > 99) {
        task.session.generateReply({
          instructions:
            'The expiration year is invalid, ask the user to repeat the expiration year.',
        });
        return undefined;
      }
      if (isExpired(expirationMonth, expirationYear)) {
        task.session.generateReply({
          instructions:
            'The expiration date is in the past, the card is expired. Ask the user to provide another card.',
        });
        return undefined;
      }

      currentExpirationDate = `${String(expirationMonth).padStart(2, '0')}/${String(expirationYear).padStart(2, '0')}`;

      if (!confirmationRequired(ctx)) {
        if (!task.done) {
          task.complete({ date: currentExpirationDate });
        }
        return undefined;
      }

      const confirmTool = buildConfirmTool(expirationMonth, expirationYear);
      const currentTools = task.toolCtx.tools.filter((t) => t.id !== 'confirm_expiration_date');
      await task.updateTools([...currentTools, confirmTool]);

      return (
        'The expiration date has been updated.\n' +
        'Do not repeat the expiration date back to the user, ask them to repeat themselves.\n' +
        'Call `confirm_expiration_date` once the user confirms, do not call it preemptively.\n'
      );
    },
  });

  const task = AgentTask.create<GetExpirationDateResult>({
    id: 'get_expiration_date_task',
    instructions: buildSubTaskInstructions(
      EXPIRATION_DATE_BASE_INSTRUCTIONS,
      EXPIRATION_DATE_AUDIO_SPECIFIC,
      EXPIRATION_DATE_TEXT_SPECIFIC,
      'Call `confirm_expiration_date` once the user has repeated their expiration date.',
      requireConfirmation,
      extraInstructions,
    ),
    chatCtx,
    tools: [updateExpirationDateTool, declineCardCaptureTool, restartCardCollectionTool],
    onEnter: async () => {
      await task.session.generateReply({
        instructions:
          "Get the user's card expiration date. First scan the conversation - if " +
          'an expiration date was already given, use it via update_expiration_date ' +
          'rather than re-asking. Only ask fresh when no date is in the conversation yet.',
      });
    },
  });

  return task;
}

export interface GetCreditCardTaskOptions {
  chatCtx?: ChatContext;
  turnDetection?: TurnDetectionMode | null;
  tools?: readonly ToolContextEntry[];
  stt?: STT | STTModelString | null;
  vad?: VAD | null;
  llm?: LLM | RealtimeModel | LLMModels | null;
  tts?: TTS | TTSModelString | null;
  allowInterruptions?: boolean;
  /**
   * Whether to ask the user to confirm each captured card detail. Defaults to confirming on
   * audio input and skipping confirmation on text input.
   */
  requireConfirmation?: boolean;
  /** Extra instructions appended to each sub-task's prompt for domain-specific context. */
  extraInstructions?: string;
}

/**
 * Build an {@link AgentTask} that collects the user's full credit card details (number,
 * expiration date, security code, and cardholder name) via a {@link TaskGroup} of sub-tasks.
 *
 * This is the functional core; {@link GetCreditCardTask} is a thin class wrapper over it.
 */
export function createGetCreditCardTask({
  chatCtx,
  turnDetection,
  tools,
  stt,
  vad,
  llm,
  tts,
  allowInterruptions,
  requireConfirmation,
  extraInstructions = '',
}: GetCreditCardTaskOptions = {}): AgentTask<GetCreditCardResult> {
  const task = AgentTask.create<GetCreditCardResult>({
    id: 'get_credit_card_task',
    instructions: '*none*',
    chatCtx,
    turnDetection: turnDetection ?? undefined,
    tools: tools ?? [],
    stt: stt ?? undefined,
    vad: vad ?? undefined,
    llm: llm ?? undefined,
    tts: tts ?? undefined,
    allowInterruptions,
    onEnter: async () => {
      // Pass chatCtx into both the TaskGroup AND every sub-task. The
      // TaskGroup overwrites each sub-task's chatCtx with its own (see
      // TaskGroup.onEnter) - without seeding the TaskGroup, sub-tasks
      // would run with empty context.
      const ctx = task.chatCtx;
      // Role hint for the cardholder sub-task. With IGNORE_ON_ENTER on
      // update_name (via requireExplicitAsk=true), the model is
      // structurally forced to ask before recording. The extra text
      // just makes sure the *question* anchors to the card.
      let cardholderExtra =
        'You are collecting the name on the credit card (the cardholder). ' +
        'When you ask the user to confirm a candidate name from earlier in ' +
        'the conversation, anchor the question to the card or cardholder ' +
        "so the user knows which name you mean - not just 'is it [name]?' " +
        'in the abstract.';
      if (extraInstructions) {
        cardholderExtra = `${extraInstructions}\n\n${cardholderExtra}`;
      }

      while (!task.done) {
        // Order: number first (most natural for the caller to give
        // when asked for "card details"), then expiry and security
        // code, then the cardholder name LAST. The name most often
        // pre-fills from chatCtx (same as the booking name) so
        // leaving it for the end avoids the failure mode where the
        // caller's first response (typically the digits) gets crammed
        // into update_name.
        const taskGroup = new TaskGroup({ chatCtx: ctx });
        taskGroup.add(
          () =>
            createGetCardNumberTask({
              chatCtx: ctx,
              requireConfirmation,
              extraInstructions,
            }),
          {
            id: 'card_number_task',
            description: "Collects the user's card number",
          },
        );
        taskGroup.add(
          () =>
            createGetExpirationDateTask({
              chatCtx: ctx,
              requireConfirmation,
              extraInstructions,
            }),
          {
            id: 'expiration_date_task',
            description: "Collects the card's expiration date",
          },
        );
        taskGroup.add(
          () =>
            createGetSecurityCodeTask({
              chatCtx: ctx,
              requireConfirmation,
              extraInstructions,
            }),
          {
            id: 'security_code_task',
            description: "Collects the card's security code",
          },
        );
        taskGroup.add(
          () =>
            createGetNameTask({
              lastName: true,
              chatCtx: ctx,
              extraInstructions: cardholderExtra,
              requireConfirmation,
              // The cardholder may differ from the caller or any guest
              // mentioned earlier in chatCtx. Apply IGNORE_ON_ENTER on
              // update_name so the model must produce an asking turn
              // rather than silently filling from chatCtx.
              requireExplicitAsk: true,
            }),
          {
            id: 'cardholder_name_task',
            description: "Collects the cardholder's full name",
          },
        );

        try {
          const results = await taskGroup.run();
          const nameResult = results.taskResults['cardholder_name_task'] as GetNameResult;
          const cardNumberResult = results.taskResults['card_number_task'] as GetCardNumberResult;
          const securityCodeResult = results.taskResults[
            'security_code_task'
          ] as GetSecurityCodeResult;
          const expirationDateResult = results.taskResults[
            'expiration_date_task'
          ] as GetExpirationDateResult;

          task.complete({
            cardholderName: `${nameResult.firstName} ${nameResult.lastName}`,
            issuer: cardNumberResult.issuer,
            cardNumber: cardNumberResult.cardNumber,
            securityCode: securityCodeResult.securityCode,
            expirationDate: expirationDateResult.date,
          });
        } catch (e) {
          if (e instanceof CardCollectionRestartError) {
            continue;
          }
          if (e instanceof CardCaptureDeclinedError || isToolError(e)) {
            if (!task.done) {
              task.complete(e as ToolError);
            }
            return;
          }
          throw e;
        }
      }
    },
  });

  return task;
}

/**
 * Class wrapper around {@link createGetCreditCardTask}, preserving the
 * `new GetCreditCardTask(options).run()` API. It composes the functional task and
 * delegates `run()` to it.
 */
export class GetCreditCardTask extends AgentTask<GetCreditCardResult> {
  readonly #task: AgentTask<GetCreditCardResult>;

  constructor(options: GetCreditCardTaskOptions = {}) {
    // The wrapper itself never runs as an agent; run() delegates to the
    // composed task. Instructions are resolved inside createGetCreditCardTask.
    super({ instructions: '' });
    this.#task = createGetCreditCardTask(options);
  }

  override run(): Promise<GetCreditCardResult> {
    return this.#task.run();
  }
}

const CARD_NUMBER_BASE_INSTRUCTIONS = `
You are a single step in a broader process of collecting credit card information.
You are solely responsible for collecting the credit card number.
{modality_specific}
If the user refuses to provide a credit card number, call decline_card_capture().
If the user wishes to start over the credit card collection process, call restart_card_collection().
Avoid listing out questions with bullet points or numbers, use a natural conversational tone.
Never repeat any sensitive information, such as the user's credit card number, back to the user.
{confirmation_instructions}
`;

const CARD_NUMBER_AUDIO_SPECIFIC = `
Handle input as noisy voice transcription. Expect users to read the card number digit by digit.
Normalize spoken digits silently: 'four' → 4, 'zero' / 'oh' → 0.
Filter out filler words or hesitations.
`;

const CARD_NUMBER_TEXT_SPECIFIC = `
Handle input as typed text. Users may type the number with or without spaces or dashes (e.g. '4152 6374 8901 2345').
`;

const SECURITY_CODE_BASE_INSTRUCTIONS = `
You are a single step in a broader process of collecting credit card information.
You are solely responsible for collecting the user's card's security code.
{modality_specific}
If the user refuses to provide a code, call decline_card_capture().
If the user wishes to start over the card collection process, call restart_card_collection().
Avoid listing out questions with bullet points or numbers, use a natural conversational tone.
Never repeat any sensitive information, such as the user's security code, back to the user.
{confirmation_instructions}
`;

const SECURITY_CODE_AUDIO_SPECIFIC = `
Handle input as noisy voice transcription. Expect users to read the security code digit by digit.
Normalize spoken digits silently: 'four' → 4, 'zero' / 'oh' → 0.
Filter out filler words or hesitations.
`;

const SECURITY_CODE_TEXT_SPECIFIC = `
Handle input as typed text. Users will type the security code directly.
`;

const EXPIRATION_DATE_BASE_INSTRUCTIONS = `
You are a single step in a broader process of collecting credit card information.
You are solely responsible for collecting the user's card's expiration date.
{modality_specific}
If the user refuses to provide a date, call decline_card_capture().
If the user wishes to start over the card collection process, call restart_card_collection().
Avoid listing out questions with bullet points or numbers, use a natural conversational tone.
Never repeat any sensitive information, such as the user's expiration date, back to the user.
{confirmation_instructions}
`;

const EXPIRATION_DATE_AUDIO_SPECIFIC = `
Handle input as noisy voice transcription. Expect users to say the expiration date in formats like 'April twenty five', 'oh four twenty five', 'four slash twenty five', or 'April 2025'.
Normalize spoken months and digits silently.
Filter out filler words or hesitations.
`;

const EXPIRATION_DATE_TEXT_SPECIFIC = `
Handle input as typed text. Expect users to type the expiration date in formats like '04/25', '04/2025', or 'April 2025'.
`;
