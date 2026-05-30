// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Instructions } from '../../llm/index.js';

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
  }
  if (event === DtmfEvent.STAR) {
    return 10;
  }
  if (event === DtmfEvent.POUND) {
    return 11;
  }
  return event.charCodeAt(0) - DtmfEvent.A.charCodeAt(0) + 12;
}

export function formatDtmf(events: DtmfEvent[]): string {
  return events.join(' ');
}

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
