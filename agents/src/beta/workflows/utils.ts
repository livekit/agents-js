// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Instructions } from '../../llm/index.js';

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
