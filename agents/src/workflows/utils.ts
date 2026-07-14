// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Instructions, isInstructions } from '../llm/chat_context.js';

/**
 * Customizable instruction sections for built-in workflow tasks.
 *
 * Leave a field unset to preserve the workflow's built-in default. Set it to
 * an empty string to remove that section entirely.
 */
export interface InstructionParts {
  /** Agent persona/identity: who the agent is and how it behaves. */
  persona?: Instructions | string;

  /** Extra instructions appended to the prompt for domain-specific context. */
  extra?: Instructions | string;
}

/**
 * Resolve workflow instructions the way the Python `WorkflowInstructions` class does:
 * a full string or {@link Instructions} replaces the built-in prompt entirely, while
 * {@link InstructionParts} (or nothing) fills the workflow's built-in template.
 *
 * @internal
 */
export function resolveWorkflowInstructions(options: {
  instructions?: InstructionParts | Instructions | string;
  template: string;
  defaultPersona: string;
  /** Fills the template's `{modalitySpecific}` slot with per-modality (audio/text) guidance. */
  modalitySpecific: Instructions;
  /** Fills the template's `{confirmation}` slot with the per-modality confirmation instruction. */
  confirmation: Instructions;
}): string | Instructions {
  const { instructions, template, defaultPersona, modalitySpecific, confirmation } = options;

  // A full instruction string or Instructions replaces the built-in prompt entirely.
  if (typeof instructions === 'string' || isInstructions(instructions)) {
    return instructions;
  }

  // No instructions or an `InstructionParts` override: fill the built-in template.
  // Unset preserves the built-in default; an explicit empty string removes the section.
  const parts: InstructionParts = instructions ?? {};
  return Instructions.resolveTemplate(template, {
    persona: parts.persona ?? defaultPersona,
    extra: parts.extra ?? '',
    modalitySpecific,
    confirmation,
  });
}

export enum DtmfEvent {
  ONE = '1',
  TWO = '2',
  THREE = '3',
  FOUR = '4',
  FIVE = '5',
  SIX = '6',
  SEVEN = '7',
  EIGHT = '8',
  NINE = '9',
  ZERO = '0',
  STAR = '*',
  POUND = '#',
  A = 'A',
  B = 'B',
  C = 'C',
  D = 'D',
}

export function dtmfEventToCode(event: DtmfEvent): number {
  if (/^\d$/.test(event)) {
    return Number(event);
  } else if (event === DtmfEvent.STAR) {
    return 10;
  } else if (event === DtmfEvent.POUND) {
    return 11;
  } else if (['A', 'B', 'C', 'D'].includes(event)) {
    // DTMF codes 12-15 are used for letters A-D
    return event.charCodeAt(0) - 'A'.charCodeAt(0) + 12;
  }
  throw new Error(`Invalid DTMF event: ${event}`);
}

export function formatDtmf(events: readonly DtmfEvent[]): string {
  return events.join(' ');
}
